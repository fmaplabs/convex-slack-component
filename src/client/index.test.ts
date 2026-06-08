import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  anyApi,
  mutationGeneric,
  queryGeneric,
  type ApiFromModules,
} from "convex/server";
import { v } from "convex/values";
import { Slack, type RunActionCtx } from "./index.js";
import type { ComponentApi } from "../component/_generated/component.js";
import { components, initConvexTest } from "./setup.test.js";

const slack = new Slack(components.slack);

// App-level wrappers around the client, registered as this test file's modules.
export const send = mutationGeneric({
  args: { text: v.string() },
  handler: async (ctx, args) => slack.send(ctx, { text: args.text }),
});

export const recent = queryGeneric({
  args: {},
  handler: async (ctx) => slack.listRecent(ctx),
});

const testApi = (
  anyApi as unknown as ApiFromModules<{
    "index.test": { send: typeof send; recent: typeof recent };
  }>
)["index.test"];

describe("client Slack", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("send enqueues and listRecent returns the sent message", async () => {
    const fetchMock = vi.fn(() => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/x");

    const t = initConvexTest();
    const id = await t.mutation(testApi.send, { text: "client hi" });
    expect(id).not.toBeNull();

    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = await t.query(testApi.recent, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
  });

  test("send is a no-op when no transport is configured", async () => {
    const t = initConvexTest();
    const id = await t.mutation(testApi.send, { text: "ignored" });
    expect(id).toBeNull();
  });
});

// The OAuth HTTP handlers are thin Response-shapers over two component actions.
// A fake component lets us assert the URL derivation + Response shaping in
// isolation (no convex-test) — the part that computes Slack's `redirect_uri`.
const INSTALL_REF = "installRedirect-ref";
const COMPLETE_REF = "completeOAuth-ref";
const fakeComponent = {
  lib: { installRedirect: INSTALL_REF, completeOAuth: COMPLETE_REF },
} as unknown as ComponentApi;

function clientWith(runAction: ReturnType<typeof vi.fn>) {
  const slack = new Slack(fakeComponent);
  const ctx = { runAction } as unknown as RunActionCtx;
  return { slack, ctx };
}

describe("installUrl", () => {
  test("joins origin + path, trims trailing slash, defaults path", () => {
    const slack = new Slack(fakeComponent);
    expect(slack.installUrl("https://dep.convex.site")).toBe(
      "https://dep.convex.site/slack/install",
    );
    expect(slack.installUrl("https://dep.convex.site/", "auth/start")).toBe(
      "https://dep.convex.site/auth/start",
    );
  });
});

describe("handleInstall", () => {
  test("derives the sibling oauth_redirect callback URL and 302s to Slack", async () => {
    const runAction = vi.fn().mockResolvedValue({
      location: "https://slack.com/oauth/v2/authorize?x=1",
    });
    const { slack, ctx } = clientWith(runAction);

    const res = await slack.handleInstall(
      ctx,
      new Request("https://dep.convex.site/slack/install"),
    );

    // The redirect_uri handed to the component must be the sibling callback —
    // this is the byte-match linchpin for the whole flow.
    expect(runAction).toHaveBeenCalledWith(INSTALL_REF, {
      redirectUri: "https://dep.convex.site/slack/oauth_redirect",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://slack.com/oauth/v2/authorize?x=1",
    );
  });

  test("derivation is prefix-agnostic (custom install path, query stripped)", async () => {
    const runAction = vi.fn().mockResolvedValue({ location: "https://slack/x" });
    const { slack, ctx } = clientWith(runAction);

    await slack.handleInstall(
      ctx,
      new Request("https://dep.convex.site/auth/slack/begin?foo=bar"),
    );
    expect(runAction).toHaveBeenCalledWith(INSTALL_REF, {
      redirectUri: "https://dep.convex.site/auth/slack/oauth_redirect",
    });
  });

  test("unconfigured component → 500", async () => {
    const runAction = vi.fn().mockResolvedValue({ error: "not configured" });
    const { slack, ctx } = clientWith(runAction);
    const res = await slack.handleInstall(
      ctx,
      new Request("https://dep.convex.site/slack/install"),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("not configured");
  });
});

describe("handleOAuthRedirect", () => {
  test("success with no successUrl → inline success page", async () => {
    const runAction = vi.fn().mockResolvedValue({ ok: true, successUrl: undefined });
    const { slack, ctx } = clientWith(runAction);

    const res = await slack.handleOAuthRedirect(
      ctx,
      new Request("https://dep.convex.site/slack/oauth_redirect?code=c1&state=s1"),
    );
    expect(runAction).toHaveBeenCalledWith(COMPLETE_REF, { code: "c1", state: "s1" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("App installed");
  });

  test("success with successUrl → 302 redirect", async () => {
    const runAction = vi
      .fn()
      .mockResolvedValue({ ok: true, successUrl: "https://app.example.com/done" });
    const { slack, ctx } = clientWith(runAction);

    const res = await slack.handleOAuthRedirect(
      ctx,
      new Request("https://dep.convex.site/slack/oauth_redirect?code=c1&state=s1"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://app.example.com/done");
  });

  test("user-denied (error param) → 400, no exchange attempted", async () => {
    const runAction = vi.fn();
    const { slack, ctx } = clientWith(runAction);
    const res = await slack.handleOAuthRedirect(
      ctx,
      new Request("https://dep.convex.site/slack/oauth_redirect?error=access_denied"),
    );
    expect(res.status).toBe(400);
    expect(runAction).not.toHaveBeenCalled();
  });

  test("missing code/state → 400, no exchange attempted", async () => {
    const runAction = vi.fn();
    const { slack, ctx } = clientWith(runAction);
    const res = await slack.handleOAuthRedirect(
      ctx,
      new Request("https://dep.convex.site/slack/oauth_redirect?state=s1"),
    );
    expect(res.status).toBe(400);
    expect(runAction).not.toHaveBeenCalled();
  });

  test("component reports failure → 400", async () => {
    const runAction = vi.fn().mockResolvedValue({ ok: false, error: "bad_code" });
    const { slack, ctx } = clientWith(runAction);
    const res = await slack.handleOAuthRedirect(
      ctx,
      new Request("https://dep.convex.site/slack/oauth_redirect?code=c1&state=s1"),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("bad_code");
  });
});
