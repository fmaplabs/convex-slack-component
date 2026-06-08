import type {
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

// See example/convex/example.ts for how to use this component.

// Convenient `ctx` aliases that only require the methods we actually call.
// A mutation, action, or query ctx all satisfy these structurally.
export type RunMutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runMutation"
>;
export type RunQueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;

export type SlackMessage = {
  /** Plain-text body / notification + a11y fallback. Always send one alongside blocks. */
  text?: string;
  /** Arbitrary Block Kit array (pass-through, no Block Kit builders here). */
  blocks?: unknown[];
  /** Channel id/name (bot-token transport only; webhook channel is fixed by URL). */
  channel?: string;
  /** Optional dedupe key — a repeat call with the same key is a no-op. */
  idempotencyKey?: string;
  /** Force a transport; default prefers the bot token when both are configured. */
  transport?: "webhook" | "botToken";
};

/**
 * Thin client over the Slack component.
 *
 * No credentials are ever passed through here — the component reads its own
 * declared env vars (`SLACK_BOT_TOKEN` / `SLACK_WEBHOOK_URL` /
 * `SLACK_DEFAULT_CHANNEL`), which the app binds in `app.use(slack, { env })`.
 */
export class Slack {
  constructor(
    public component: ComponentApi,
    public options?: { defaultChannel?: string },
  ) {}

  /**
   * Enqueue a message. Call from an app mutation to get the transactional
   * guarantee (the enqueue rolls back with the surrounding mutation), or from
   * an action for fire-and-forget.
   *
   * @returns the message id, or `null` if no transport is configured (no-op).
   */
  send(ctx: RunMutationCtx, message: SlackMessage): Promise<string | null> {
    return ctx.runMutation(this.component.lib.enqueue, {
      text: message.text,
      blocks: message.blocks,
      channel: message.channel ?? this.options?.defaultChannel,
      idempotencyKey: message.idempotencyKey,
      transport: message.transport,
    });
  }

  /** Recent logged messages, most recent first. */
  listRecent(ctx: RunQueryCtx, limit?: number) {
    return ctx.runQuery(this.component.lib.list, { limit });
  }
}
