# Developing this component

`@fmaplabs/convex-slack` is a Convex component, published on npm. To work on it,
run a dev process in the bundled example project:

```sh
pnpm i
pnpm run dev
```

`pnpm run dev` starts a file watcher that rebuilds the component and runs the
example backend (which installs and uses the component). Run
`pnpm run dev:frontend` to interact with it through a Vite app.

The component code lives in `src/component/` (its schema, queries, mutations,
and actions) and `src/client/` (the `Slack` class consumers use). Publish with
`pnpm run alpha` or `pnpm run release`.

### Component directory structure

```
.
├── README.md           documentation of this component
├── package.json        component name, version number, other metadata
├── pnpm-lock.yaml      committed (this repo uses pnpm)
├── src
│   ├── component/
│   │   ├── _generated/        Files here are generated for the component.
│   │   ├── convex.config.ts   Names the component and uses other components
│   │   ├── lib.ts             Component functions (enqueue, list, ...)
│   │   └── schema.ts          Schema specific to this component
│   └── client/
│       └── index.ts           The Slack class the consuming app imports
├── example/            example Convex app that uses this component
│   └── convex/
│       ├── _generated/        Files here are generated for the example app.
│       ├── convex.config.ts   Imports and uses this component
│       ├── example.ts         Functions that use the component
│       └── schema.ts          Example app schema
└── dist/               Publishing artifacts will be created here.
```

---

# Convex Slack

[![npm version](https://badge.fury.io/js/@fmaplabs%2Fconvex-slack.svg)](https://badge.fury.io/js/@fmaplabs%2Fconvex-slack)

<!-- START: Include on https://convex.dev/components -->

Durable Slack notifications for Convex apps. Enqueue a message inside any
mutation and the component delivers it through a nested workpool — with retries,
idempotency, and a silent no-op when no Slack credentials are configured.

Found a bug? Feature request?
[File it here](https://github.com/fmaplabs/convex-slack/issues).

## Installation

Create a `convex.config.ts` file in your app's `convex/` folder, declare the
Slack env vars, and bind them to the component **by reference** (live values,
set later with `npx convex env set`):

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import slack from "@fmaplabs/convex-slack/convex.config.js";

const app = defineApp({
  env: {
    SLACK_WEBHOOK_URL: v.optional(v.string()),
    SLACK_BOT_TOKEN: v.optional(v.string()),
    SLACK_DEFAULT_CHANNEL: v.optional(v.string()),
  },
});

app.use(slack, {
  env: {
    SLACK_WEBHOOK_URL: app.env.SLACK_WEBHOOK_URL,
    SLACK_BOT_TOKEN: app.env.SLACK_BOT_TOKEN,
    SLACK_DEFAULT_CHANNEL: app.env.SLACK_DEFAULT_CHANNEL,
  },
});

export default app;
```

Transports: an Incoming Webhook (`SLACK_WEBHOOK_URL`) or a bot token
(`SLACK_BOT_TOKEN` → `chat.postMessage`, with `SLACK_DEFAULT_CHANNEL`). The bot
token is preferred when both are set; with neither set, sends are a silent
no-op. See [docs/consumer-integration.md](./docs/consumer-integration.md) for a
full walkthrough.

## Usage

Construct one `Slack` client for your app, then call `send` from any mutation.
`send` returns the message id, or `null` when no `SLACK_*` env var is configured
(a no-op):

```ts
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { components } from "./_generated/api";
import { Slack } from "@fmaplabs/convex-slack";

// No credentials here — the component reads the env vars bound in convex.config.ts.
const slack = new Slack(components.slack);

export const notify = mutation({
  args: { text: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    return await slack.send(ctx, {
      text: args.text,
      // Optional Block Kit (pass-through). Always send `text` as a fallback.
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: args.text },
        },
      ],
      // A repeat call with the same key is a no-op — derive it from the
      // chokepoint so a retried job can't double-post.
      idempotencyKey: `notify:${args.text}`,
    });
  },
});
```

See more example usage in [example.ts](./example/convex/example.ts).

### HTTP Routes

The Slack client exposes HTTP **handlers** that you mount from your own
`convex/http.ts` — your app owns the route paths (no `httpPrefix` config):

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { slack } from "./example"; // wherever you construct `new Slack(...)`

const http = httpRouter();

// "Add to Slack" install + OAuth callback (see "OAuth installation" below).
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

export default http;
```

The handlers run in your app's `httpAction` and delegate to the component (which
still reads its own bound env — no credentials pass through the client). Mount
the OAuth callback as a sibling named `oauth_redirect`.

## OAuth installation ("Add to Slack")

The transports above use a single token you paste once. To let **end users
install your app into their own Slack workspace** — each getting its own bot
token — use the OAuth v2 flow. This mounts two more HTTP routes under your
`httpPrefix` and stores a per-workspace installation.

**1. Configure the Slack app.** In your app's settings at api.slack.com:

- Under **OAuth & Permissions → Redirect URLs**, add
  `<your-site>/slack/oauth_redirect` (the `.convex.site` origin + your
  `httpPrefix` + `oauth_redirect`). It must byte-match exactly.
- Add the **Bot Token Scopes** you need (at minimum `chat:write`).
- Copy the **Client ID** and **Client Secret**.

**2. Set the env vars** (bound through `app.use(slack, { env })` alongside the
others — see the example app's `convex.config.ts`):

```sh
npx convex env set SLACK_CLIENT_ID     <client-id>
npx convex env set SLACK_CLIENT_SECRET <client-secret>
npx convex env set SLACK_SCOPES        chat:write
# optional: where to send the browser after a successful install
npx convex env set SLACK_INSTALL_SUCCESS_URL https://your-app.example.com/installed
```

All optional — with `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` unset, the install
routes return a clear "not configured" message and `oauth` sends no-op.

**3. Mount the routes and render the install link.** Mount `handleInstall` /
`handleOAuthRedirect` in your `convex/http.ts` (see [HTTP Routes](#http-routes)
above). Then point a button at `slack.installUrl(siteUrl)` — where `siteUrl` is
your `CONVEX_SITE_URL` (the `.convex.site` origin) — which builds
`<site>/slack/install`. Hitting it 302s the user to Slack's consent screen; on
approval Slack calls your `oauth_redirect` route, which exchanges the `code` for
the workspace's bot token and stores an installation row.

**4. Send to an installed workspace.** OAuth is multi-tenant, so `send` requires
an explicit `teamId` — there's no ambiguous auto-select:

```ts
await slack.send(ctx, {
  text: "Build finished ✅",
  teamId: "T0123ABCD", // the installed workspace's team id
  transport: "oauth",
});
```

The token is looked up at delivery time, so reinstalls are picked up
automatically. A missing installation fails the message with `no_installation`
(no retries).

> **Token storage:** bot tokens are stored **in plaintext** in the component's
> `installations` table — the same as any database-backed Slack
> `InstallationStore`. If your threat model requires encryption at rest, encrypt
> before storage; the schema leaves room (`refreshToken`/`expiresAt`) for future
> token rotation.

<!-- END: Include on https://convex.dev/components -->

Run the example:

```sh
pnpm i
pnpm run dev
```
