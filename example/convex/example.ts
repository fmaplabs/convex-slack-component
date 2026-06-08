import { mutation, query } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { Slack } from "@fmaplabs/convex-slack";
import { v } from "convex/values";

// One Slack client for the app. No credentials here — the component reads the
// env vars bound in convex.config.ts. HTTP routes are mounted by the app in
// convex/http.ts (see that file), so there's no httpPrefix to configure.
export const slack = new Slack(components.slack);

type LifecycleEvent = {
  emoji: string;
  title: string;
  customerName: string;
  customerEmail: string;
  change: string;
  actor: string;
  contractId: number;
  contractUrl?: string;
};

/**
 * Compose a subscription-lifecycle notification: a header, a 2-column field
 * grid, and a plain-text fallback (always send `text` alongside `blocks` for
 * notifications + accessibility).
 */
function lifecycleMessage(e: LifecycleEvent): { text: string; blocks: unknown[] } {
  const text = [
    `${e.emoji} ${e.title}`,
    `Customer: ${e.customerName} (${e.customerEmail})`,
    `Change: ${e.change}`,
    `By: ${e.actor}`,
    `Contract: #${e.contractId}`,
  ].join("\n");

  // Slack only renders `<url|label>` as a link when `url` is absolute (has an
  // http(s):// scheme). A scheme-less URL is shown literally — so normalize it.
  const href = e.contractUrl
    ? /^https?:\/\//.test(e.contractUrl)
      ? e.contractUrl
      : `https://${e.contractUrl}`
    : undefined;
  const contractField = href
    ? `*Contract:*\n<${href}|#${e.contractId} ↗ open in cargo>`
    : `*Contract:*\n#${e.contractId}`;

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${e.emoji} ${e.title}`, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Customer:*\n${e.customerName} (${e.customerEmail})` },
        { type: "mrkdwn", text: `*Change:*\n${e.change}` },
        { type: "mrkdwn", text: `*By:*\n${e.actor}` },
        { type: "mrkdwn", text: contractField },
      ],
    },
  ];

  return { text, blocks };
}

export const notifySkip = mutation({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const { text, blocks } = lifecycleMessage({
      emoji: "⏭️",
      title: "Cycle skipped",
      customerName: "Jane Doe",
      customerEmail: "jane@acme.com",
      change: "cycle 5 (period 2026-07-04)",
      actor: "Jane Doe — customer (storefront)",
      contractId: 123,
      contractUrl: "https://cargo.example.com/contracts/123",
    });
    // A real caller derives this from the chokepoint (e.g. `${contractId}:skip:${jobId}`).
    return await slack.send(ctx, {
      text,
      blocks,
      idempotencyKey: `demo-skip:123:${Date.now()}`,
    });
  },
});

export const notifyCancel = mutation({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const { text, blocks } = lifecycleMessage({
      emoji: "🛑",
      title: "Subscription cancelled",
      customerName: "Jane Doe",
      customerEmail: "jane@acme.com",
      change: "contract cancelled",
      actor: "Shopify admin / automatic",
      contractId: 123,
      contractUrl: "https://cargo.example.com/contracts/123",
    });
    return await slack.send(ctx, {
      text,
      blocks,
      idempotencyKey: `demo-cancel:123:${Date.now()}`,
    });
  },
});

/**
 * Deliver to a specific installed workspace via the OAuth transport. After a
 * user completes the "Add to Slack" flow, the component has that workspace's
 * own bot token keyed by `teamId` — pass it here to address the right install.
 */
export const notifyOAuth = mutation({
  args: { teamId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { teamId }) => {
    return await slack.send(ctx, {
      text: "👋 Hello from the OAuth transport — sent with this workspace's own bot token.",
      teamId,
      transport: "oauth",
      idempotencyKey: `demo-oauth:${teamId}:${Date.now()}`,
    });
  },
});

export const recentNotifications = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await slack.listRecent(ctx, args.limit);
  },
});
