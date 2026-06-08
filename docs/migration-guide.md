# Migration guide — adding OAuth, and the HTTP-mounting change

This release adds a third transport (`oauth`) and an "Add to Slack" installation
flow. The send API (`slack.send`) and the webhook / bot-token transports are
**unchanged** — existing callers and tests need no edits.

There is **one breaking change**, and it only affects you if you used `httpPrefix`
to expose the component's `GET /last` route.

| Change | Breaking? | Action |
| --- | --- | --- |
| `oauth` transport + `teamId` on `send` | No | Opt-in; ignore if unused |
| New env vars (`SLACK_CLIENT_ID` / `SECRET` / `SCOPES` / `INSTALL_SUCCESS_URL`) | No | Optional; unset ⇒ install routes 500 / `oauth` no-ops |
| New tables (`installations`, `oauthStates`) + `teamId` on `messages` | No | Auto via codegen; no data migration |
| HTTP routes: `httpPrefix` removed; app mounts handlers itself | **Yes**, if you used `httpPrefix` | See §1 |

---

## 1. HTTP routes are now app-mounted (breaking if you used `httpPrefix`)

The component no longer ships its own `http.ts` or mount itself under an
`httpPrefix`. Instead — following the `@convex-dev/resend` pattern — your app mounts
the handlers from its own `convex/http.ts` via the `Slack` client. This gives you
control of the route paths and keeps the OAuth `redirect_uri` robust (it's derived in
a plain app `httpAction`, where `req.url` is the full external URL).

**Before** (`convex/convex.config.ts`):

```ts
app.use(slack, {
  httpPrefix: "/slack/",
  env: { /* … */ },
});
// component exposed GET /slack/last automatically
```

**After** — drop `httpPrefix` from `app.use`:

```ts
app.use(slack, {
  // no httpPrefix
  env: { /* … */ },
});
```

…and create/extend `convex/http.ts`:

```ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { slack } from "./example"; // wherever you construct `new Slack(...)`

const http = httpRouter();

// OAuth flow (only needed if you adopt `oauth` — see §4).
http.route({
  path: "/slack/install",
  method: "GET",
  handler: httpAction((ctx, req) => slack.handleInstall(ctx, req)),
});
http.route({
  path: "/slack/oauth_redirect",
  method: "GET",
  handler: httpAction((ctx, req) => slack.handleOAuthRedirect(ctx, req)),
});

// If you relied on the old GET /slack/last, reproduce it yourself:
http.route({
  path: "/slack/last",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const recent = await slack.listRecent(ctx, 1);
    return new Response(JSON.stringify(recent[0] ?? null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
```

Mount the OAuth callback as a **sibling named `oauth_redirect`** of your install
route — `handleInstall` derives Slack's `redirect_uri` by swapping the final path
segment for `oauth_redirect`.

If you don't use OAuth and never used `httpPrefix`, you can skip this section.

---

## 2. Schema additions (no data migration)

`installations`, `oauthStates`, and the new optional `teamId` on `messages` are
picked up automatically — all new `messages` fields are optional, so existing rows
remain valid. Just regenerate:

```sh
pnpm run build:codegen   # or: npx convex dev
```

No backfill is required.

---

## 3. New environment variables (optional)

All optional and bound by reference like the existing ones. Declare them on the app
and bind them through `app.use(slack, { env })`:

```ts
const app = defineApp({
  env: {
    SLACK_WEBHOOK_URL: v.optional(v.string()),
    SLACK_BOT_TOKEN: v.optional(v.string()),
    SLACK_DEFAULT_CHANNEL: v.optional(v.string()),
    SLACK_CLIENT_ID: v.optional(v.string()),
    SLACK_CLIENT_SECRET: v.optional(v.string()),
    SLACK_SCOPES: v.optional(v.string()),
    SLACK_INSTALL_SUCCESS_URL: v.optional(v.string()),
  },
});

app.use(slack, {
  env: {
    SLACK_WEBHOOK_URL: app.env.SLACK_WEBHOOK_URL,
    SLACK_BOT_TOKEN: app.env.SLACK_BOT_TOKEN,
    SLACK_DEFAULT_CHANNEL: app.env.SLACK_DEFAULT_CHANNEL,
    SLACK_CLIENT_ID: app.env.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: app.env.SLACK_CLIENT_SECRET,
    SLACK_SCOPES: app.env.SLACK_SCOPES,
    SLACK_INSTALL_SUCCESS_URL: app.env.SLACK_INSTALL_SUCCESS_URL,
  },
});
```

Leaving them unset keeps the install routes returning a clear "not configured"
message and `oauth` sends a no-op.

---

## 4. Adopting the `oauth` transport

1. **Slack app config** (api.slack.com): add `<your-site>/slack/oauth_redirect` (the
   `.convex.site` origin + your install route's sibling) under **Redirect URLs**; add
   the **Bot Token Scopes** you need (≥ `chat:write`); copy the **Client ID** /
   **Client Secret**.
2. **Set env** on the deployment:
   ```sh
   npx convex env set SLACK_CLIENT_ID     <client-id>
   npx convex env set SLACK_CLIENT_SECRET <client-secret>
   npx convex env set SLACK_SCOPES        chat:write
   ```
3. **Render the install link** — `slack.installUrl(siteUrl)` (where `siteUrl` is your
   `CONVEX_SITE_URL`) → `<site>/slack/install`. Hitting it 302s to Slack's consent
   screen; on approval the `oauth_redirect` handler stores the workspace's bot token.
4. **Send to a workspace** — `oauth` is multi-tenant, so pass an explicit `teamId`:
   ```ts
   await slack.send(ctx, { text: "…", teamId: "T0123ABCD", transport: "oauth" });
   ```

The token is looked up at delivery time (reinstalls are picked up); a missing
installation fails the message with `no_installation` (no retries). Tokens are stored
plaintext — see `architecture.md`.

---

## 5. What stays the same

- `slack.send(ctx, { text, blocks, channel, idempotencyKey })` — identical behavior.
- `webhook` / `botToken` transports, transactional enqueue, idempotency, the workpool
  retry/backoff, and the no-op-when-unconfigured guarantee — all unchanged.
- `selectTransport` still prefers the bot token and never returns `oauth` unless you
  pass `transport: "oauth"` explicitly (with client creds configured).

## Verify

```sh
pnpm run build:codegen && pnpm run typecheck && pnpm test
```

Then, if adopting OAuth, do the real end-to-end check: click the install link,
complete consent, confirm an `installations` row, trigger an `oauth` send, and confirm
the message arrives.
