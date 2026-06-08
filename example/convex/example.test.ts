import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("example lifecycle notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("no-op when no transport is configured", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.example.notifySkip, {});
    expect(id).toBeNull();
    const recent = await t.query(api.example.recentNotifications, {});
    expect(recent).toHaveLength(0);
  });

  test("posts via webhook when configured", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/x");

    const t = initConvexTest();
    const id = await t.mutation(api.example.notifyCancel, {});
    expect(id).not.toBeNull();

    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const recent = await t.query(api.example.recentNotifications, {});
    expect(recent).toHaveLength(1);
    expect(recent[0].status).toBe("sent");
    expect(recent[0].transport).toBe("webhook");
  });
});
