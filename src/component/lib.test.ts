/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import {
  buildAuthorizeUrl,
  classifyFailure,
  parseOAuthAccessResponse,
  postMessageBody,
  selectTransport,
  webhookBody,
} from "./lib.js";

const WEBHOOK_URL = "https://hooks.slack.com/services/T/B/x";

function stubFetch(impl: () => Promise<Response> | Response) {
  const fetchMock =
    vi.fn<(url: string, init: RequestInit) => Promise<Response> | Response>(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const drain = (t: ReturnType<typeof initConvexTest>) =>
  t.finishAllScheduledFunctions(() => vi.runAllTimers());

describe("pure helpers", () => {
  test("selectTransport prefers bot token, honors override, no-ops when empty", () => {
    expect(selectTransport({ SLACK_BOT_TOKEN: "t", SLACK_WEBHOOK_URL: "w" })).toBe(
      "botToken",
    );
    expect(selectTransport({ SLACK_WEBHOOK_URL: "w" })).toBe("webhook");
    expect(selectTransport({})).toBeNull();
    expect(
      selectTransport({ SLACK_BOT_TOKEN: "t", SLACK_WEBHOOK_URL: "w" }, "webhook"),
    ).toBe("webhook");
    // Override without its credential → no-op.
    expect(selectTransport({ SLACK_WEBHOOK_URL: "w" }, "botToken")).toBeNull();
  });

  test("selectTransport: oauth needs client creds + explicit override, never auto-selects", () => {
    const creds = { SLACK_CLIENT_ID: "c", SLACK_CLIENT_SECRET: "s" };
    expect(selectTransport(creds, "oauth")).toBe("oauth");
    // Missing either credential → no-op.
    expect(selectTransport({ SLACK_CLIENT_ID: "c" }, "oauth")).toBeNull();
    expect(selectTransport({ SLACK_BOT_TOKEN: "t" }, "oauth")).toBeNull();
    // oauth is never the default, even when client creds are present.
    expect(selectTransport(creds)).toBeNull();
    expect(selectTransport({ ...creds, SLACK_BOT_TOKEN: "t" })).toBe("botToken");
  });

  test("buildAuthorizeUrl: well-formed Slack consent URL", () => {
    const url = buildAuthorizeUrl({
      clientId: "cid",
      scopes: "chat:write,channels:read",
      state: "st8",
      redirectUri: "https://x.convex.site/slack/oauth_redirect",
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("scope")).toBe("chat:write,channels:read");
    expect(u.searchParams.get("state")).toBe("st8");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://x.convex.site/slack/oauth_redirect",
    );
  });

  test("parseOAuthAccessResponse: maps team + enterprise installs", () => {
    expect(
      parseOAuthAccessResponse({
        access_token: "xoxb-1",
        team: { id: "T1" },
        bot_user_id: "U1",
        app_id: "A1",
        scope: "chat:write",
        authed_user: { id: "U2" },
        is_enterprise_install: false,
      }),
    ).toEqual({
      teamId: "T1",
      enterpriseId: undefined,
      isEnterpriseInstall: false,
      botToken: "xoxb-1",
      botUserId: "U1",
      appId: "A1",
      scope: "chat:write",
      authedUserId: "U2",
    });
    const org = parseOAuthAccessResponse({
      access_token: "xoxb-2",
      enterprise: { id: "E1" },
      is_enterprise_install: true,
    });
    expect(org.enterpriseId).toBe("E1");
    expect(org.isEnterpriseInstall).toBe(true);
  });

  test("classifyFailure: 5xx/429 retryable, 4xx permanent", () => {
    expect(classifyFailure(500)).toBe("retryable");
    expect(classifyFailure(429)).toBe("retryable");
    expect(classifyFailure(404)).toBe("permanent");
    expect(classifyFailure(200, { error: "channel_not_found" })).toBe("permanent");
    expect(classifyFailure(200, { error: "internal_error" })).toBe("retryable");
  });

  test("body builders only include provided fields", () => {
    expect(webhookBody({ text: "hi" })).toEqual({ text: "hi" });
    expect(postMessageBody({ channel: "C1", blocks: [1] })).toEqual({
      channel: "C1",
      blocks: [1],
    });
  });
});

describe("enqueue + send pipeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("webhook send: one fetch, row marked sent", async () => {
    const fetchMock = stubFetch(() => new Response("ok", { status: 200 }));
    vi.stubEnv("SLACK_WEBHOOK_URL", WEBHOOK_URL);

    const t = initConvexTest();
    const id = await t.mutation(api.lib.enqueue, { text: "hello", blocks: [{ a: 1 }] });
    expect(id).not.toBeNull();

    await drain(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(JSON.parse(init.body as string)).toEqual({ text: "hello", blocks: [{ a: 1 }] });

    const rows = await t.query(api.lib.list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].transport).toBe("webhook");
    expect(rows[0].httpStatus).toBe(200);
  });

  test("bot-token send: Web API url + auth header, ts stored", async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(JSON.stringify({ ok: true, ts: "1700000000.000100" }), {
          status: 200,
        }),
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    vi.stubEnv("SLACK_DEFAULT_CHANNEL", "C-default");

    const t = initConvexTest();
    await t.mutation(api.lib.enqueue, { text: "hi", channel: "C-override" });
    await drain(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer xoxb-test",
    );
    const body = JSON.parse(init.body as string);
    expect(body.channel).toBe("C-override"); // per-call channel beats default

    const rows = await t.query(api.lib.list, {});
    expect(rows[0].status).toBe("sent");
    expect(rows[0].transport).toBe("botToken");
    expect(rows[0].channel).toBe("C-override");
    expect(rows[0].slackTs).toBe("1700000000.000100");
  });

  test("permanent failure: no retry, no throw out of enqueue, row failed", async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
          status: 200,
        }),
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    vi.stubEnv("SLACK_DEFAULT_CHANNEL", "C-default");

    const t = initConvexTest();
    const id = await t.mutation(api.lib.enqueue, { text: "hi" });
    expect(id).not.toBeNull(); // enqueue did not throw
    await drain(t);

    expect(fetchMock).toHaveBeenCalledTimes(1); // not retried
    const rows = await t.query(api.lib.list, {});
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toBe("channel_not_found");
  });

  test("retryable failure: pool retries, terminal failed", async () => {
    const fetchMock = stubFetch(() => new Response("upstream", { status: 500 }));
    vi.stubEnv("SLACK_WEBHOOK_URL", WEBHOOK_URL);

    const t = initConvexTest();
    await t.mutation(api.lib.enqueue, { text: "hi" });
    await drain(t);

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2); // retried
    const rows = await t.query(api.lib.list, {});
    expect(rows[0].status).toBe("failed");
  });

  test("no-op when unconfigured: null, no row, no fetch", async () => {
    const fetchMock = stubFetch(() => new Response("ok", { status: 200 }));
    // no SLACK_* env stubbed

    const t = initConvexTest();
    const id = await t.mutation(api.lib.enqueue, { text: "hi" });
    expect(id).toBeNull();
    await drain(t);

    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await t.query(api.lib.list, {});
    expect(rows).toHaveLength(0);
  });

  test("idempotency: same key twice → one row, one fetch", async () => {
    const fetchMock = stubFetch(() => new Response("ok", { status: 200 }));
    vi.stubEnv("SLACK_WEBHOOK_URL", WEBHOOK_URL);

    const t = initConvexTest();
    const id1 = await t.mutation(api.lib.enqueue, {
      text: "hi",
      idempotencyKey: "evt-1",
    });
    const id2 = await t.mutation(api.lib.enqueue, {
      text: "hi again",
      idempotencyKey: "evt-1",
    });
    expect(id2).toBe(id1); // deduped
    await drain(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = await t.query(api.lib.list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("hi"); // first wins
  });

  test("transactional rollback: enqueue-then-throw leaves no row, no work", async () => {
    const fetchMock = stubFetch(() => new Response("ok", { status: 200 }));
    vi.stubEnv("SLACK_WEBHOOK_URL", WEBHOOK_URL);

    const t = initConvexTest();
    await expect(
      t.run(async (ctx) => {
        await ctx.runMutation(api.lib.enqueue, { text: "doomed" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await drain(t);
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await t.query(api.lib.list, {});
    expect(rows).toHaveLength(0);
  });
});

describe("oauth installation flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const REDIRECT_URI = "https://x.convex.site/slack/oauth_redirect";

  test("installRedirect: returns authorize URL and stores the state nonce", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "csec");
    vi.stubEnv("SLACK_SCOPES", "chat:write,channels:read");

    const t = initConvexTest();
    const res = await t.action(api.lib.installRedirect, {
      redirectUri: REDIRECT_URI,
    });

    expect("location" in res).toBe(true);
    const location = (res as { location: string }).location;
    const u = new URL(location);
    expect(`${u.origin}${u.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    const state = u.searchParams.get("state");
    expect(state).toBeTruthy();

    const states = await t.run((ctx) => ctx.db.query("oauthStates").collect());
    expect(states).toHaveLength(1);
    expect(states[0].state).toBe(state);
    expect(states[0].redirectUri).toBe(REDIRECT_URI);
  });

  test("installRedirect: unconfigured → error, no state written", async () => {
    const t = initConvexTest();
    const res = await t.action(api.lib.installRedirect, { redirectUri: REDIRECT_URI });
    expect(res).toEqual({
      error: expect.stringContaining("not configured") as unknown as string,
    });
    const states = await t.run((ctx) => ctx.db.query("oauthStates").collect());
    expect(states).toHaveLength(0);
  });

  test("completeOAuth: exchanges code, upserts installation, consumes state", async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-team-1",
            team: { id: "T1" },
            bot_user_id: "U1",
            app_id: "A1",
            scope: "chat:write",
            authed_user: { id: "U2" },
            is_enterprise_install: false,
          }),
          { status: 200 },
        ),
    );
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "csec");

    const t = initConvexTest();
    await t.run((ctx) =>
      ctx.db.insert("oauthStates", {
        state: "s1",
        redirectUri: REDIRECT_URI,
        createdAt: Date.now(),
      }),
    );

    const res = await t.action(api.lib.completeOAuth, { code: "code-1", state: "s1" });
    expect(res).toEqual({ ok: true, successUrl: undefined });

    // Token exchange used the stored redirect_uri (byte-match guarantee).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/oauth.v2.access");
    const body = init.body as URLSearchParams;
    expect(body.get("code")).toBe("code-1");
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(body.get("client_id")).toBe("cid");

    const installs = await t.run((ctx) =>
      ctx.db.query("installations").collect(),
    );
    expect(installs).toHaveLength(1);
    expect(installs[0].teamId).toBe("T1");
    expect(installs[0].botToken).toBe("xoxb-team-1");

    // Single-use: the state row is gone.
    const states = await t.run((ctx) => ctx.db.query("oauthStates").collect());
    expect(states).toHaveLength(0);
  });

  test("completeOAuth: unknown state is rejected", async () => {
    const fetchMock = stubFetch(() => new Response("{}", { status: 200 }));
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "csec");

    const t = initConvexTest();
    const res = await t.action(api.lib.completeOAuth, {
      code: "c",
      state: "never-issued",
    });
    expect(res).toEqual({ ok: false, error: "invalid_or_expired_state" });
    expect(fetchMock).not.toHaveBeenCalled(); // no token exchange on bad state
  });

  test("completeOAuth: expired state is rejected (TTL), no token exchange", async () => {
    const fetchMock = stubFetch(() => new Response("{}", { status: 200 }));
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "csec");

    const t = initConvexTest();
    // Seed a state nonce older than the 10-minute TTL.
    await t.run((ctx) =>
      ctx.db.insert("oauthStates", {
        state: "stale",
        redirectUri: REDIRECT_URI,
        createdAt: Date.now() - 11 * 60 * 1000,
      }),
    );

    const res = await t.action(api.lib.completeOAuth, { code: "c", state: "stale" });
    expect(res).toEqual({ ok: false, error: "invalid_or_expired_state" });
    expect(fetchMock).not.toHaveBeenCalled();

    // Expired row is still consumed (deleted), so it can't be retried.
    const states = await t.run((ctx) => ctx.db.query("oauthStates").collect());
    expect(states).toHaveLength(0);
  });

  test("oauth send: uses the stored installation token, row sent", async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(JSON.stringify({ ok: true, ts: "1700000000.000200" }), {
          status: 200,
        }),
    );
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "csec");

    const t = initConvexTest();
    await t.run((ctx) =>
      ctx.db.insert("installations", {
        teamId: "T1",
        isEnterpriseInstall: false,
        botToken: "xoxb-T1",
        installedAt: Date.now(),
      }),
    );

    const id = await t.mutation(api.lib.enqueue, {
      text: "hi",
      channel: "C1",
      teamId: "T1",
      transport: "oauth",
    });
    expect(id).not.toBeNull();
    await drain(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer xoxb-T1",
    );

    const rows = await t.query(api.lib.list, {});
    expect(rows[0].status).toBe("sent");
    expect(rows[0].transport).toBe("oauth");
    expect(rows[0].teamId).toBe("T1");
  });

  test("oauth send: missing installation → failed/no_installation, no fetch", async () => {
    const fetchMock = stubFetch(() => new Response("ok", { status: 200 }));
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "csec");

    const t = initConvexTest();
    const id = await t.mutation(api.lib.enqueue, {
      text: "hi",
      channel: "C1",
      teamId: "T-unknown",
      transport: "oauth",
    });
    expect(id).not.toBeNull();
    await drain(t);

    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await t.query(api.lib.list, {});
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toBe("no_installation");
  });

  test("oauth enqueue without teamId is rejected", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "csec");

    const t = initConvexTest();
    await expect(
      t.mutation(api.lib.enqueue, { text: "hi", transport: "oauth" }),
    ).rejects.toThrow(/teamId/);
  });
});
