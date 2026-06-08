import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  anyApi,
  mutationGeneric,
  queryGeneric,
  type ApiFromModules,
} from "convex/server";
import { v } from "convex/values";
import { Slack } from "./index.js";
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
