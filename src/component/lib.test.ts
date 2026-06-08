/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import {
  classifyFailure,
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
