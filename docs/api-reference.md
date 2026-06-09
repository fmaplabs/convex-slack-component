# API reference — `@fmaplabs/convex-slack`

## Environment variables (declared by the component)

Declared in `src/component/convex.config.ts`; bound by the app in
`app.use(slack, { env: { … } })`. All optional — none set ⇒ silent no-op.

| Var | Purpose |
| --- | --- |
| `SLACK_WEBHOOK_URL` | Incoming Webhook URL. Channel is fixed by the URL. |
| `SLACK_BOT_TOKEN` | Bot token for Web API `chat.postMessage`. **Preferred** when both single-token transports are set. |
| `SLACK_DEFAULT_CHANNEL` | Default channel for the bot-token **and** oauth transports. |
| `SLACK_CLIENT_ID` | OAuth app client id — enables the `oauth` transport + install flow. |
| `SLACK_CLIENT_SECRET` | OAuth app client secret (used at token exchange). |
| `SLACK_SCOPES` | Comma-separated bot scopes for the consent screen (e.g. `chat:write,channels:read`). |
| `SLACK_INSTALL_SUCCESS_URL` | Optional post-install redirect; falls back to an inline success page. |

## Client — `Slack`

```ts
import { Slack } from "@fmaplabs/convex-slack";
import { components } from "./_generated/api";

const slack = new Slack(components.slack, { defaultChannel: "#ops" }); // options optional
```

### `new Slack(component, options?)`
- `component: ComponentApi` — `components.slack` from your app's generated api.
- `options?: { defaultChannel?: string }` — fallback channel applied in `send`.

### `send(ctx, message): Promise<string | null>`
Enqueues a message. Call from an app **mutation** for the transactional guarantee, or
from an **action** for fire-and-forget. Returns the message id, or `null` if no
transport is configured.

`ctx`: anything with `runMutation` (mutation / action ctx).

`message: SlackMessage`:

| field | type | notes |
| --- | --- | --- |
| `text` | `string?` | plain-text body / fallback — always include one |
| `blocks` | `unknown[]?` | arbitrary Block Kit (pass-through) |
| `channel` | `string?` | bot-token / oauth; falls back to `options.defaultChannel`, then `SLACK_DEFAULT_CHANNEL` |
| `teamId` | `string?` | **required for `oauth`** — the installed workspace to deliver to; ignored otherwise |
| `idempotencyKey` | `string?` | repeat call with same key is a no-op (returns the existing id) |
| `transport` | `"webhook" \| "botToken" \| "oauth"?` | force a transport; default prefers the bot token. `oauth` is never auto-selected and requires `teamId` + client creds |

### `listRecent(ctx, limit?)`
`ctx`: anything with `runQuery`. Returns recent `messages` rows, newest first
(`limit` default 100).

### `listInstallations(ctx): Promise<SlackInstallation[]>`
`ctx`: anything with `runQuery`. Lists installed workspaces, newest install first,
as **token-free** metadata (`teamId`, `enterpriseId`, `isEnterpriseInstall`,
`botUserId`, `appId`, `scope`, `authedUserId`, `installedAt`) — the bot token is
never exposed. Reactive: re-runs when an install completes or is replaced. Use it to
discover the `teamId` for an `oauth` send (instead of asking a human to type it), or
to show that an install has completed. It reflects installs, not uninstalls (there's
no `app_uninstalled` handling yet), so read it as "installed at least once," not
"connected right now." Single-workspace apps take the first entry; multi-tenant hosts
map each `teamId` to their own account model.

### `installUrl(convexSiteUrl, installPath?)`
Builds the "Add to Slack" link to render in your app. `convexSiteUrl` is your
`CONVEX_SITE_URL` (the `.convex.site` origin); `installPath` is wherever you
mounted the install route (default `/slack/install`). Returns the URL string.

### `handleInstall(ctx, req): Promise<Response>`
HTTP handler for your install route. `ctx`: anything with `runAction` (httpAction
ctx). 302s the user to Slack's consent screen, or 500 if OAuth isn't configured.
Derives Slack's `redirect_uri` from `req.url` by replacing the final path segment
with `oauth_redirect`, so mount the callback as a sibling with that name.

### `handleOAuthRedirect(ctx, req): Promise<Response>`
HTTP handler for the OAuth callback (Slack's redirect target). Validates `state`,
exchanges `code` for the workspace's bot token, stores the installation, then 302s
to `SLACK_INSTALL_SUCCESS_URL` (if set) or returns a minimal success page. Friendly
4xx on user-denied / missing params / bad code.

Mount both from your app's `convex/http.ts`:

```ts
http.route({ path: "/slack/install", method: "GET",
  handler: httpAction((ctx, req) => slack.handleInstall(ctx, req)) });
http.route({ path: "/slack/oauth_redirect", method: "GET",
  handler: httpAction((ctx, req) => slack.handleOAuthRedirect(ctx, req)) });
```

## Component functions (`components.slack.lib.*`)

Call these directly from app functions if you aren't using the client.

### `enqueue` — `mutation` → `Id<"messages"> | null`
Args: `{ text?, blocks?, channel?, teamId?, idempotencyKey?, transport? }` (same
shape as `SlackMessage`). Resolves transport from env, dedupes on `idempotencyKey`,
inserts a `pending` row, schedules `send` through the workpool, returns the id (or
`null`). Throws if `transport` resolves to `oauth` without a `teamId`.

### `list` — `query` → `Message[]`
Args: `{ limit? }`. Newest-first.

### `listInstallations` — `query` → `Installation[]` (token-free)
Args: `{}`. Lists installed workspaces newest-first, **without** the bot token
(`teamId`, `enterpriseId`, `isEnterpriseInstall`, `botUserId`, `appId`, `scope`,
`authedUserId`, `installedAt`). The token-bearing read (`getInstallationToken`)
stays internal; this is its safe, host-facing counterpart.

### `installRedirect` — `action` → `{ location } | { error }`
Args: `{ redirectUri }`. Reads the OAuth env, generates a CSRF `state` (Web Crypto),
stores it, and returns the Slack consent URL (`location`) — or `{ error }` if
`SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SCOPES` aren't all set. Public so
the host app's `handleInstall` can call it; credentials stay in the component.

### `completeOAuth` — `action` → `{ ok:true, successUrl? } | { ok:false, error }`
Args: `{ code, state }`. Consumes the `state` (single-use, ~10-min TTL), exchanges
`code` at `oauth.v2.access` using the stored `redirectUri`, and upserts the
installation. Errors: `invalid_or_expired_state`, `not_configured`, or Slack's own.

### Internal (not part of the app-facing API)
- `send` — `internalAction` `{ id }` → `{ ok:true, httpStatus, ts? } | { ok:false, httpStatus?, error }`. Throws on retryable failure (network / 429 / 5xx). For `oauth`, looks the token up at delivery time via `getInstallationToken`; missing install → `{ ok:false, error:"no_installation" }`.
- `onSendComplete` — `internalMutation` (workpool `onComplete`); maps the run result to the row's `status`.
- `getMessage` — `internalQuery` `{ id }` → `Message | null`.
- `markSkipped` — `internalMutation` `{ id, error? }` → patches a row to `skipped`.
- `insertOAuthState` — `internalMutation` `{ state, redirectUri }` → stores a nonce (`createdAt` stamped here).
- `consumeOAuthState` — `internalMutation` `{ state }` → `{ redirectUri } | null`; single-use, rejects on miss/expiry.
- `upsertInstallation` — `internalMutation` (installation fields) → insert/replace keyed by `teamId` (or `enterpriseId`).
- `getInstallationToken` — `internalQuery` `{ teamId?, enterpriseId? }` → `string | null`.

## `messages` table

| field | type | |
| --- | --- | --- |
| `text` | `string?` | |
| `blocks` | `any?` | Block Kit array (pass-through) |
| `channel` | `string?` | resolved channel (bot-token / oauth) |
| `teamId` | `string?` | target workspace (oauth transport only) |
| `transport` | `"webhook" \| "botToken" \| "oauth"` | |
| `idempotencyKey` | `string?` | indexed: `by_idempotencyKey` |
| `status` | `"pending" \| "sent" \| "failed" \| "skipped"` | |
| `workId` | `string?` | correlates to the workpool item |
| `httpStatus` | `number?` | |
| `error` | `string?` | |
| `slackTs` | `string?` | `chat.postMessage` `ts` (bot-token / oauth success) |

## `installations` table
One row per installed workspace (or org). Written by `completeOAuth`, read at
delivery time by `send` (token, internal) and listed by `listInstallations`
(token-free, host-facing). Indexes: `by_teamId`, `by_enterpriseId`.

| field | type | |
| --- | --- | --- |
| `teamId` | `string?` | single-workspace install |
| `enterpriseId` | `string?` | org-wide install |
| `isEnterpriseInstall` | `boolean` | |
| `botToken` | `string` | `xoxb-…` (**plaintext** — see architecture doc) |
| `botUserId` / `appId` / `scope` / `authedUserId` | `string?` | from `oauth.v2.access` |
| `installedAt` | `number` | |
| `refreshToken` / `expiresAt` | `string? / number?` | reserved for future token rotation |

## `oauthStates` table
Short-lived CSRF nonce for the install → callback round-trip. Index: `by_state`.

| field | type | |
| --- | --- | --- |
| `state` | `string` | random nonce (Web Crypto, generated in the action) |
| `redirectUri` | `string` | exact value sent to Slack; replayed at exchange |
| `createdAt` | `number` | consumed rows older than ~10 min are rejected |

## Pure helpers (exported from `lib.ts`, unit-testable)
- `selectTransport(env, override?) → "webhook" | "botToken" | "oauth" | null` — `oauth` only via explicit override + `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`; never auto-selected
- `buildAuthorizeUrl({ clientId, scopes, state, redirectUri }) → string` — the `oauth/v2/authorize` URL
- `parseOAuthAccessResponse(json) → Installation` — maps `oauth.v2.access` JSON onto an installation record
- `webhookBody(msg)` / `postMessageBody(msg)` — build the request body, omitting absent fields
- `classifyFailure(status, json?) → "retryable" | "permanent"`

## HTTP routes
The component no longer mounts its own routes via `httpPrefix`. Instead, the host
app mounts handlers in its own `convex/http.ts` (the resend pattern):

- `slack.handleInstall(ctx, req)` → mount at e.g. `GET /slack/install`
- `slack.handleOAuthRedirect(ctx, req)` → mount at `GET /slack/oauth_redirect` (sibling of install)
- `GET /last`-style "most recent send" is now app-owned: call `slack.listRecent(ctx, 1)` in your own route.

See `migration-guide.md` if you previously used `httpPrefix`.

## Testing
Register the component (and its nested workpool) with convex-test via the shipped
helper:

```ts
import component from "@fmaplabs/convex-slack/test";
component.register(t); // registers "slack" + "slack/sendWorkpool"
```

Stub env + fetch per test and drain the workpool:

```ts
vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/x");
vi.stubGlobal("fetch", vi.fn(() => new Response("ok", { status: 200 })));
// …after t.mutation(...)…
await t.finishAllScheduledFunctions(() => vi.runAllTimers());
```
