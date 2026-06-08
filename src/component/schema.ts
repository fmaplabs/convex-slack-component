import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Which Slack API a message is delivered through. */
export const vTransport = v.union(v.literal("webhook"), v.literal("botToken"));

/** Lifecycle of a logged message. */
export const vStatus = v.union(
  v.literal("pending"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("skipped"),
);

export default defineSchema({
  // Every send is logged here. The row is the unit of idempotency and the
  // audit record of what happened to a notification.
  messages: defineTable({
    text: v.optional(v.string()),
    blocks: v.optional(v.any()), // arbitrary Block Kit array (pass-through)
    channel: v.optional(v.string()), // resolved channel (bot-token transport only)
    transport: vTransport,
    idempotencyKey: v.optional(v.string()),
    status: vStatus,
    workId: v.optional(v.string()), // correlates to the workpool item
    httpStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    slackTs: v.optional(v.string()), // chat.postMessage `ts`
  }).index("by_idempotencyKey", ["idempotencyKey"]),
});
