import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

// See example/convex/example.ts for how to use this component.

// Convenient `ctx` aliases that only require the methods we actually call.
// A mutation, action, or query ctx all satisfy these structurally.
//
// All based on `GenericActionCtx` (the loosest run* signatures) on purpose:
// convex 1.41 added a `transactionLimits` option to query/mutation-ctx run*
// methods that action ctx lacks, so basing these on query/mutation ctx would
// reject callers passing an action ctx.
export type RunMutationCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runMutation"
>;
export type RunQueryCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery">;
export type RunActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runAction">;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Derive the OAuth `redirect_uri` from the incoming `/install` request URL by
 * replacing its final path segment with `oauth_redirect`, keeping the origin
 * and prefix intact (so it's prefix-agnostic). Mount your callback route as a
 * sibling named `oauth_redirect`. The value is stored at install time and
 * replayed verbatim at token exchange, so the two always byte-match.
 */
function deriveCallbackUrl(reqUrl: string): string {
  const u = new URL(reqUrl);
  u.pathname = u.pathname.replace(/[^/]+\/?$/, "oauth_redirect");
  u.search = "";
  return u.toString();
}

export type SlackMessage = {
  /** Plain-text body / notification + a11y fallback. Always send one alongside blocks. */
  text?: string;
  /** Arbitrary Block Kit array (pass-through, no Block Kit builders here). */
  blocks?: unknown[];
  /** Channel id/name (bot-token / oauth transports; webhook channel is fixed by URL). */
  channel?: string;
  /**
   * Installed workspace to deliver to. **Required** for the `oauth` transport
   * (multi-tenant: each workspace has its own bot token); ignored otherwise.
   */
  teamId?: string;
  /** Optional dedupe key — a repeat call with the same key is a no-op. */
  idempotencyKey?: string;
  /**
   * Force a transport. Default prefers the bot token when both webhook and bot
   * token are configured; `oauth` is never auto-selected and must be requested
   * explicitly (it requires `teamId` and configured OAuth client creds).
   */
  transport?: "webhook" | "botToken" | "oauth";
};

/**
 * Token-free metadata for one installed workspace. Mirrors the component's
 * `listInstallations` return — the bot token is **never** included.
 */
export type SlackInstallation = {
  /** Workspace id (`T…`) for a single-workspace install. */
  teamId?: string;
  /** Org id (`E…`) for an enterprise / org-wide install. */
  enterpriseId?: string;
  isEnterpriseInstall: boolean;
  /** The installed bot user (`U…`). */
  botUserId?: string;
  appId?: string;
  /** Granted bot scopes, comma-separated. */
  scope?: string;
  authedUserId?: string;
  /** Epoch ms of the (most recent) install. */
  installedAt: number;
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
      teamId: message.teamId,
      idempotencyKey: message.idempotencyKey,
      transport: message.transport,
    });
  }

  /** Recent logged messages, most recent first. */
  listRecent(ctx: RunQueryCtx, limit?: number) {
    return ctx.runQuery(this.component.lib.list, { limit });
  }

  /**
   * List installed Slack workspaces (token-free metadata), newest install first.
   *
   * Reactive — re-runs when an install completes or is replaced. Use it to discover
   * the `teamId` to pass to `send({ transport: "oauth", teamId })` instead of asking
   * a human to type it, or to show that an install has completed. (It reflects
   * installs, not uninstalls — there's no `app_uninstalled` handling yet — so read it
   * as "installed at least once," not "connected right now.") The bot token is never
   * exposed; it stays internal to the component.
   *
   * Single-workspace apps can take the first entry; multi-tenant hosts map each
   * `teamId` to their own account model.
   */
  listInstallations(ctx: RunQueryCtx): Promise<SlackInstallation[]> {
    return ctx.runQuery(this.component.lib.listInstallations, {});
  }

  /**
   * Build the "Add to Slack" install link to render in your app. Point a button
   * or anchor at it; hitting it (your `/install` route → `handleInstall`) 302s
   * the user to Slack's consent screen.
   *
   * `convexSiteUrl` is your deployment's HTTP Actions origin (`CONVEX_SITE_URL`,
   * the `.convex.site` URL); `installPath` is wherever you mounted the install
   * route (defaults to `/slack/install`).
   */
  installUrl(convexSiteUrl: string, installPath = "/slack/install"): string {
    const path = installPath.startsWith("/") ? installPath : `/${installPath}`;
    return `${convexSiteUrl.replace(/\/+$/, "")}${path}`;
  }

  /**
   * Handler for your `/install` route. Mount it from your app's `convex/http.ts`:
   *
   * ```ts
   * http.route({ path: "/slack/install", method: "GET",
   *   handler: httpAction((ctx, req) => slack.handleInstall(ctx, req)) });
   * ```
   *
   * Redirects (302) to Slack's consent screen, or returns 500 if OAuth isn't
   * configured. The callback must be mounted as a sibling named `oauth_redirect`.
   */
  async handleInstall(ctx: RunActionCtx, req: Request): Promise<Response> {
    const redirectUri = deriveCallbackUrl(req.url);
    const result = await ctx.runAction(this.component.lib.installRedirect, {
      redirectUri,
    });
    if ("error" in result) return htmlResponse(result.error, 500);
    return new Response(null, {
      status: 302,
      headers: { Location: result.location },
    });
  }

  /**
   * Handler for your `oauth_redirect` callback route (Slack's redirect target).
   * Mount it as a sibling of the install route:
   *
   * ```ts
   * http.route({ path: "/slack/oauth_redirect", method: "GET",
   *   handler: httpAction((ctx, req) => slack.handleOAuthRedirect(ctx, req)) });
   * ```
   *
   * Exchanges the `code` for the workspace's bot token, stores the installation,
   * and either 302s to `SLACK_INSTALL_SUCCESS_URL` or shows a minimal success page.
   */
  async handleOAuthRedirect(ctx: RunActionCtx, req: Request): Promise<Response> {
    const params = new URL(req.url).searchParams;

    const error = params.get("error");
    if (error) {
      // e.g. the user clicked "Cancel" on the consent screen.
      return htmlResponse(`Slack installation was cancelled (${error}).`, 400);
    }

    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      return htmlResponse("Missing code or state in the OAuth callback.", 400);
    }

    const result = await ctx.runAction(this.component.lib.completeOAuth, {
      code,
      state,
    });
    if (!result.ok) {
      return htmlResponse(`Slack installation failed: ${result.error}.`, 400);
    }
    if (result.successUrl) {
      return new Response(null, {
        status: 302,
        headers: { Location: result.successUrl },
      });
    }
    return htmlResponse(
      "<!doctype html><html><body><h1>App installed ✅</h1><p>You can close this window.</p></body></html>",
    );
  }
}
