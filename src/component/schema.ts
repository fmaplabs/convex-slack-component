import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Which Slack API a message is delivered through. */
export const vTransport = v.union(
  v.literal("webhook"),
  v.literal("botToken"),
  v.literal("oauth"),
);

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
    channel: v.optional(v.string()), // resolved channel (bot-token / oauth transports)
    teamId: v.optional(v.string()), // installed workspace to deliver to (oauth transport)
    transport: vTransport,
    idempotencyKey: v.optional(v.string()),
    status: vStatus,
    workId: v.optional(v.string()), // correlates to the workpool item
    httpStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    slackTs: v.optional(v.string()), // chat.postMessage `ts`
  }).index("by_idempotencyKey", ["idempotencyKey"]),

  // One row per installed workspace (or org, for enterprise installs). Written
  // by the OAuth callback; read at delivery time so reinstalls are picked up.
  installations: defineTable({
    teamId: v.optional(v.string()), // single-workspace install
    enterpriseId: v.optional(v.string()), // org-wide install
    isEnterpriseInstall: v.boolean(),
    botToken: v.string(), // xoxb-… (plaintext; see README note)
    botUserId: v.optional(v.string()),
    appId: v.optional(v.string()),
    scope: v.optional(v.string()),
    authedUserId: v.optional(v.string()),
    installedAt: v.number(),
    // Room for future token rotation — unused for now:
    refreshToken: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_teamId", ["teamId"])
    .index("by_enterpriseId", ["enterpriseId"]),

  // Short-lived CSRF nonce for the install → callback round-trip.
  oauthStates: defineTable({
    state: v.string(),
    redirectUri: v.string(), // exact value sent to Slack; reused at exchange
    createdAt: v.number(),
  }).index("by_state", ["state"]),
});
