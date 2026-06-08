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

Pass an `httpPrefix` to the same `app.use(slack, ...)` call to mount the
component's HTTP routes under that prefix:

```ts
// convex/convex.config.ts
app.use(slack, {
  httpPrefix: "/slack/",
  env: {
    SLACK_WEBHOOK_URL: app.env.SLACK_WEBHOOK_URL,
    SLACK_BOT_TOKEN: app.env.SLACK_BOT_TOKEN,
    SLACK_DEFAULT_CHANNEL: app.env.SLACK_DEFAULT_CHANNEL,
  },
});
```

With the prefix above the component exposes `GET /slack/last`, which returns the
most recent send as JSON.

<!-- END: Include on https://convex.dev/components -->

Run the example:

```sh
pnpm i
pnpm run dev
```
