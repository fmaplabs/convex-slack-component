import { v, type Infer } from "convex/values";
import { Workpool, vOnCompleteArgs } from "@convex-dev/workpool";
import {
  action,
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

export type Transport = "webhook" | "botToken" | "oauth";

type Env = {
  SLACK_BOT_TOKEN?: string;
  SLACK_WEBHOOK_URL?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
};

/**
 * Resolve which transport to use. Bot token is preferred when both are set.
 * A per-call `override` must still have its credential configured, otherwise
 * (and when nothing is configured) we return null → the caller no-ops.
 *
 * `oauth` is multi-tenant-ambiguous (which workspace?), so it never auto-selects
 * — it's only chosen via an explicit override, and only when OAuth client creds
 * are configured. The addressing `teamId` is validated in `enqueue`.
 */
export function selectTransport(env: Env, override?: Transport): Transport | null {
  if (override === "oauth")
    return env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET ? "oauth" : null;
  if (override === "botToken") return env.SLACK_BOT_TOKEN ? "botToken" : null;
  if (override === "webhook") return env.SLACK_WEBHOOK_URL ? "webhook" : null;
  if (env.SLACK_BOT_TOKEN) return "botToken";
  if (env.SLACK_WEBHOOK_URL) return "webhook";
  return null;
}

/** Build the Slack OAuth v2 consent-screen URL the install link redirects to. */
export function buildAuthorizeUrl(opts: {
  clientId: string;
  scopes: string;
  state: string;
  redirectUri: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    scope: opts.scopes,
    state: opts.state,
    redirect_uri: opts.redirectUri,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

/** Installation record derived from a Slack `oauth.v2.access` response. */
export type Installation = {
  teamId?: string;
  enterpriseId?: string;
  isEnterpriseInstall: boolean;
  botToken: string;
  botUserId?: string;
  appId?: string;
  scope?: string;
  authedUserId?: string;
};

/** Map Slack's `oauth.v2.access` JSON onto an installation record. */
export function parseOAuthAccessResponse(json: {
  access_token?: string;
  bot_user_id?: string;
  app_id?: string;
  scope?: string;
  team?: { id?: string } | null;
  enterprise?: { id?: string } | null;
  is_enterprise_install?: boolean;
  authed_user?: { id?: string } | null;
}): Installation {
  return {
    teamId: json.team?.id ?? undefined,
    enterpriseId: json.enterprise?.id ?? undefined,
    isEnterpriseInstall: json.is_enterprise_install ?? false,
    botToken: json.access_token ?? "",
    botUserId: json.bot_user_id,
    appId: json.app_id,
    scope: json.scope,
    authedUserId: json.authed_user?.id,
  };
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
 * POST to `chat.postMessage` with a bearer token. Shared by the `botToken` and
 * `oauth` transports — both hit the Web API, differing only in where the token
 * comes from. Throws on retryable failures (network / 429 / 5xx); returns
 * `{ ok: false }` on permanent ones.
 */
async function postMessageViaWebApi(
  token: string,
  body: Record<string, unknown>,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
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
    teamId: v.optional(v.string()),
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

    // OAuth delivery is multi-tenant: the caller must say which workspace.
    if (transport === "oauth" && !args.teamId) {
      throw new Error(
        "transport 'oauth' requires a teamId to address an installed workspace",
      );
    }

    const key = args.idempotencyKey;
    if (key !== undefined) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", key))
        .unique();
      if (existing) return existing._id;
    }

    // Both Web API transports (botToken, oauth) need a channel; the webhook's
    // channel is fixed by its URL.
    const channel =
      transport === "webhook"
        ? undefined
        : (args.channel ?? process.env.SLACK_DEFAULT_CHANNEL);

    const id = await ctx.db.insert("messages", {
      text: args.text,
      blocks: args.blocks,
      channel,
      teamId: transport === "oauth" ? args.teamId : undefined,
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
      return await postMessageViaWebApi(token, postMessageBody(row));
    }

    if (row.transport === "oauth") {
      if (!row.teamId) return { ok: false, error: "missing_team_id" };
      // Look up the token at delivery time so reinstalls are picked up.
      const token: string | null = await ctx.runQuery(
        internal.lib.getInstallationToken,
        { teamId: row.teamId },
      );
      if (!token) return { ok: false, error: "no_installation" };
      return await postMessageViaWebApi(token, postMessageBody(row));
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

// ---------------------------------------------------------------------------
// OAuth installation flow
// ---------------------------------------------------------------------------

// A consumed state older than this is rejected (CSRF / stale-link protection).
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Persist a CSRF nonce for the install → callback round-trip. The nonce itself
 * is generated in the httpAction (Web Crypto), not here — transactional
 * randomness is restricted.
 */
export const insertOAuthState = internalMutation({
  args: { state: v.string(), redirectUri: v.string() },
  handler: async (ctx, { state, redirectUri }) => {
    await ctx.db.insert("oauthStates", {
      state,
      redirectUri,
      createdAt: Date.now(),
    });
  },
});

/**
 * Look up a state nonce, delete it (single-use), and reject if missing or
 * expired. Returns the stored `redirectUri` — the exact value sent to Slack at
 * authorize time, which must be replayed byte-for-byte at token exchange.
 */
export const consumeOAuthState = internalMutation({
  args: { state: v.string() },
  returns: v.union(v.object({ redirectUri: v.string() }), v.null()),
  handler: async (ctx, { state }) => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", state))
      .unique();
    if (!row) return null;
    await ctx.db.delete("oauthStates", row._id);
    if (Date.now() - row.createdAt > OAUTH_STATE_TTL_MS) return null;
    return { redirectUri: row.redirectUri };
  },
});

/**
 * Insert or replace the installation for a workspace (keyed by `teamId`, or
 * `enterpriseId` for org-wide installs) so reinstalls overwrite the old token.
 */
export const upsertInstallation = internalMutation({
  args: {
    teamId: v.optional(v.string()),
    enterpriseId: v.optional(v.string()),
    isEnterpriseInstall: v.boolean(),
    botToken: v.string(),
    botUserId: v.optional(v.string()),
    appId: v.optional(v.string()),
    scope: v.optional(v.string()),
    authedUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing =
      args.isEnterpriseInstall && args.enterpriseId
        ? await ctx.db
            .query("installations")
            .withIndex("by_enterpriseId", (q) =>
              q.eq("enterpriseId", args.enterpriseId),
            )
            .unique()
        : args.teamId
          ? await ctx.db
              .query("installations")
              .withIndex("by_teamId", (q) => q.eq("teamId", args.teamId))
              .unique()
          : null;

    const row = { ...args, installedAt: Date.now() };
    if (existing) {
      await ctx.db.replace("installations", existing._id, row);
    } else {
      await ctx.db.insert("installations", row);
    }
  },
});

/** Fetch a workspace's stored bot token (by `teamId`, or `enterpriseId`). */
export const getInstallationToken = internalQuery({
  args: { teamId: v.optional(v.string()), enterpriseId: v.optional(v.string()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { teamId, enterpriseId }) => {
    let row = null;
    if (enterpriseId) {
      row = await ctx.db
        .query("installations")
        .withIndex("by_enterpriseId", (q) => q.eq("enterpriseId", enterpriseId))
        .unique();
    }
    if (!row && teamId) {
      row = await ctx.db
        .query("installations")
        .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
        .unique();
    }
    return row?.botToken ?? null;
  },
});

/**
 * Public, token-free projection of an installation: everything Slack returned at
 * install time *except* the bot token (and the reserved rotation secrets). Safe to
 * expose to the host app and, through it, to a client.
 */
const vInstallationView = v.object({
  teamId: v.optional(v.string()),
  enterpriseId: v.optional(v.string()),
  isEnterpriseInstall: v.boolean(),
  botUserId: v.optional(v.string()),
  appId: v.optional(v.string()),
  scope: v.optional(v.string()),
  authedUserId: v.optional(v.string()),
  installedAt: v.number(),
});

/**
 * List installed workspaces, newest install first — **without** the bot token.
 *
 * The token-bearing read (`getInstallationToken`) is deliberately internal; this is
 * its host-facing counterpart. It lets the app discover the `teamId` to pass to
 * `send({ transport: "oauth", teamId })` (instead of asking a human to type it) and
 * show that an install has completed — it's reactive, updating the moment one
 * completes or is replaced. (It reflects installs, not uninstalls: there's no
 * `app_uninstalled` handling yet, so read it as "installed at least once," not
 * "connected right now.") The token never crosses this boundary: the returns
 * validator only permits the fields above, so adding one is a deliberate act.
 *
 * Multi-tenant by design: single-workspace apps take the first entry; multi-tenant
 * hosts map each `teamId` to their own account model.
 */
export const listInstallations = query({
  args: {},
  returns: v.array(vInstallationView),
  handler: async (ctx) => {
    const rows = await ctx.db.query("installations").collect();
    return rows
      .sort((a, b) => b.installedAt - a.installedAt)
      .map((r) => ({
        teamId: r.teamId,
        enterpriseId: r.enterpriseId,
        isEnterpriseInstall: r.isEnterpriseInstall,
        botUserId: r.botUserId,
        appId: r.appId,
        scope: r.scope,
        authedUserId: r.authedUserId,
        installedAt: r.installedAt,
      }));
  },
});

/**
 * Begin the "Add to Slack" flow. The host app's HTTP route calls this from its
 * own `httpAction` (via `slack.handleInstall`) and 302s the user to `location`.
 *
 * Public so the host app can call it through `components.slack.lib.*` — it reads
 * the component-bound OAuth env so credentials never pass through the client.
 * `redirectUri` is derived from the request URL by the client (it's the only
 * party that sees it) and replayed verbatim at token exchange.
 */
export const installRedirect = action({
  args: { redirectUri: v.string() },
  returns: v.union(
    v.object({ location: v.string() }),
    v.object({ error: v.string() }),
  ),
  handler: async (ctx, { redirectUri }) => {
    const clientId = process.env.SLACK_CLIENT_ID;
    const scopes = process.env.SLACK_SCOPES;
    // Require the secret here too: it isn't used until the callback, but failing
    // now beats sending the user through consent only to fail at the exchange.
    if (!clientId || !scopes || !process.env.SLACK_CLIENT_SECRET) {
      return {
        error:
          "Slack OAuth is not configured: set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_SCOPES.",
      };
    }
    // Web Crypto is available in the (non-Node) action runtime; randomness is
    // fine here because actions aren't transactional.
    const state = crypto.randomUUID();
    await ctx.runMutation(internal.lib.insertOAuthState, { state, redirectUri });
    return { location: buildAuthorizeUrl({ clientId, scopes, state, redirectUri }) };
  },
});

/**
 * Complete the OAuth callback: validate `state`, exchange `code` for a bot
 * token, and persist the installation. Returns `successUrl` (the configured
 * post-install redirect, if any) so the client can finish the browser flow.
 */
export const completeOAuth = action({
  args: { code: v.string(), state: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), successUrl: v.optional(v.string()) }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
  handler: async (ctx, { code, state }) => {
    const consumed: { redirectUri: string } | null = await ctx.runMutation(
      internal.lib.consumeOAuthState,
      { state },
    );
    if (!consumed) return { ok: false as const, error: "invalid_or_expired_state" };

    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return { ok: false as const, error: "not_configured" };
    }

    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: consumed.redirectUri,
      }),
    });
    const json = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      access_token?: string;
      bot_user_id?: string;
      app_id?: string;
      scope?: string;
      team?: { id?: string } | null;
      enterprise?: { id?: string } | null;
      is_enterprise_install?: boolean;
      authed_user?: { id?: string } | null;
    };
    if (!json.ok) {
      return { ok: false as const, error: json.error ?? "oauth_exchange_failed" };
    }

    await ctx.runMutation(
      internal.lib.upsertInstallation,
      parseOAuthAccessResponse(json),
    );
    return { ok: true as const, successUrl: process.env.SLACK_INSTALL_SUCCESS_URL };
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
