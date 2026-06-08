import { v, type Infer } from "convex/values";
import { Workpool, vOnCompleteArgs } from "@convex-dev/workpool";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import schema, { vTransport } from "./schema.js";

const vMessage = schema.tables.messages.validator.extend({
  _id: v.id("messages"),
  _creationTime: v.number(),
});

// Durable, retried delivery. Slack exposes no idempotency key, so a lost-ack
// retry can rarely double-post — acceptable for ops alerts. Actions that hit a
// retryable failure *throw* (the pool retries with backoff); permanent failures
// *return* so we don't waste retries.
const pool = new Workpool(components.sendWorkpool, {
  maxParallelism: 5,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 4, initialBackoffMs: 1000, base: 2 },
});

// ---------------------------------------------------------------------------
// Pure, unit-testable helpers
// ---------------------------------------------------------------------------

export type Transport = "webhook" | "botToken";

type Env = { SLACK_BOT_TOKEN?: string; SLACK_WEBHOOK_URL?: string };

/**
 * Resolve which transport to use. Bot token is preferred when both are set.
 * A per-call `override` must still have its credential configured, otherwise
 * (and when nothing is configured) we return null → the caller no-ops.
 */
export function selectTransport(env: Env, override?: Transport): Transport | null {
  if (override === "botToken") return env.SLACK_BOT_TOKEN ? "botToken" : null;
  if (override === "webhook") return env.SLACK_WEBHOOK_URL ? "webhook" : null;
  if (env.SLACK_BOT_TOKEN) return "botToken";
  if (env.SLACK_WEBHOOK_URL) return "webhook";
  return null;
}

/** Incoming Webhook payload — channel is fixed by the webhook URL. */
export function webhookBody(msg: { text?: string; blocks?: unknown }) {
  const body: Record<string, unknown> = {};
  if (msg.text !== undefined) body.text = msg.text;
  if (msg.blocks !== undefined) body.blocks = msg.blocks;
  return body;
}

/** Web API `chat.postMessage` payload — channel is required. */
export function postMessageBody(msg: {
  channel?: string;
  text?: string;
  blocks?: unknown;
}) {
  const body: Record<string, unknown> = {};
  if (msg.channel !== undefined) body.channel = msg.channel;
  if (msg.text !== undefined) body.text = msg.text;
  if (msg.blocks !== undefined) body.blocks = msg.blocks;
  return body;
}

const RETRYABLE_SLACK_ERRORS = new Set([
  "internal_error",
  "service_unavailable",
  "fatal_error",
]);

/**
 * Decide whether a failed send is worth retrying. Transport (5xx) and rate
 * limiting (429) are transient; logical 4xx errors (e.g. `channel_not_found`,
 * `invalid_auth`) are permanent.
 */
export function classifyFailure(
  status: number,
  json?: { error?: string },
): "retryable" | "permanent" {
  if (status === 429 || status >= 500) return "retryable";
  if (json?.error && RETRYABLE_SLACK_ERRORS.has(json.error)) return "retryable";
  return "permanent";
}

// ---------------------------------------------------------------------------
// Send pipeline
// ---------------------------------------------------------------------------

const vSendResult = v.union(
  v.object({
    ok: v.literal(true),
    httpStatus: v.number(),
    ts: v.optional(v.string()),
  }),
  v.object({
    ok: v.literal(false),
    httpStatus: v.optional(v.number()),
    error: v.string(),
  }),
);
type SendResult = Infer<typeof vSendResult>;

/**
 * Transactional enqueue. Runs in the *caller's* transaction when invoked via
 * `ctx.runMutation` from an app mutation: the row insert and the workpool
 * enqueue roll back together if the app mutation throws.
 *
 * Returns the message id, or null when:
 * - no transport is configured (silent no-op), or
 * - `idempotencyKey` matches an existing row (returns that row's id).
 */
export const enqueue = mutation({
  args: {
    text: v.optional(v.string()),
    blocks: v.optional(v.any()),
    channel: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    transport: v.optional(vTransport),
  },
  returns: v.union(v.id("messages"), v.null()),
  handler: async (ctx, args) => {
    const transport = selectTransport(process.env, args.transport);
    if (transport === null) {
      // Unconfigured deployment → write nothing, enqueue nothing.
      return null;
    }

    const key = args.idempotencyKey;
    if (key !== undefined) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", key))
        .unique();
      if (existing) return existing._id;
    }

    const channel =
      transport === "botToken"
        ? (args.channel ?? process.env.SLACK_DEFAULT_CHANNEL)
        : undefined;

    const id = await ctx.db.insert("messages", {
      text: args.text,
      blocks: args.blocks,
      channel,
      transport,
      idempotencyKey: args.idempotencyKey,
      status: "pending",
    });

    const workId = await pool.enqueueAction(
      ctx,
      internal.lib.send,
      { id },
      { onComplete: internal.lib.onSendComplete, context: { id } },
    );
    await ctx.db.patch("messages", id, { workId });
    return id;
  },
});

/**
 * Deliver a single logged message. Driven by the workpool:
 * - throws on retryable failure (network / 429 / 5xx) → the pool retries;
 * - returns `{ ok: false, ... }` on permanent failure → no pointless retries;
 * - returns `{ ok: true, ... }` on success.
 */
export const send = internalAction({
  args: { id: v.id("messages") },
  returns: vSendResult,
  handler: async (ctx, { id }): Promise<SendResult> => {
    const row: Infer<typeof vMessage> | null = await ctx.runQuery(
      internal.lib.getMessage,
      { id },
    );
    if (!row) return { ok: false, error: "message_not_found" };

    if (row.transport === "botToken") {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) return { ok: false, error: "missing_bot_token" };

      let response: Response;
      try {
        response = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(postMessageBody(row)),
        });
      } catch (e) {
        // Network-level failure → retryable.
        throw new Error(`slack chat.postMessage fetch failed: ${String(e)}`);
      }
      const httpStatus = response.status;
      if (httpStatus === 429 || httpStatus >= 500) {
        throw new Error(`slack chat.postMessage http ${httpStatus}`);
      }
      // The Web API returns HTTP 200 even on logical failure — inspect `ok`.
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        ts?: string;
        error?: string;
      };
      if (json.ok) return { ok: true, httpStatus, ts: json.ts };
      if (classifyFailure(httpStatus, json) === "retryable") {
        throw new Error(`slack chat.postMessage error: ${json.error ?? "unknown"}`);
      }
      return { ok: false, httpStatus, error: json.error ?? "unknown_error" };
    }

    // Incoming Webhook.
    const url = process.env.SLACK_WEBHOOK_URL;
    if (!url) return { ok: false, error: "missing_webhook_url" };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookBody(row)),
      });
    } catch (e) {
      throw new Error(`slack webhook fetch failed: ${String(e)}`);
    }
    const httpStatus = response.status;
    if (httpStatus === 429 || httpStatus >= 500) {
      throw new Error(`slack webhook http ${httpStatus}`);
    }
    if (httpStatus >= 200 && httpStatus < 300) {
      return { ok: true, httpStatus };
    }
    const errText = await response.text().catch(() => "");
    return { ok: false, httpStatus, error: errText || `http_${httpStatus}` };
  },
});

/**
 * Terminal-outcome handler for the workpool. Maps the run result onto the
 * message row's status.
 */
export const onSendComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ id: v.id("messages") })),
  handler: async (ctx, { context, result }) => {
    const id = context.id;
    if (result.kind === "success") {
      const r = result.returnValue as SendResult;
      if (r.ok) {
        await ctx.db.patch("messages", id, {
          status: "sent",
          httpStatus: r.httpStatus,
          ...(r.ts ? { slackTs: r.ts } : {}),
        });
      } else {
        await ctx.db.patch("messages", id, {
          status: "failed",
          httpStatus: r.httpStatus,
          error: r.error,
        });
      }
    } else if (result.kind === "failed") {
      // Retries exhausted.
      await ctx.db.patch("messages", id, {
        status: "failed",
        error: result.error,
      });
    } else {
      // Canceled before it ran.
      await ctx.db.patch("messages", id, { status: "skipped" });
    }
  },
});

// ---------------------------------------------------------------------------
// Reads / utilities
// ---------------------------------------------------------------------------

export const getMessage = internalQuery({
  args: { id: v.id("messages") },
  returns: v.union(v.null(), vMessage),
  handler: async (ctx, { id }) => {
    return await ctx.db.get("messages", id);
  },
});

/** Mark a message skipped (e.g. when its work was canceled). */
export const markSkipped = internalMutation({
  args: { id: v.id("messages"), error: v.optional(v.string()) },
  handler: async (ctx, { id, error }) => {
    await ctx.db.patch("messages", id, {
      status: "skipped",
      ...(error ? { error } : {}),
    });
  },
});

/** Most-recent-first list of logged messages, for dashboards / debugging. */
export const list = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(vMessage),
  handler: async (ctx, args) => {
    return await ctx.db.query("messages").order("desc").take(args.limit ?? 100);
  },
});
