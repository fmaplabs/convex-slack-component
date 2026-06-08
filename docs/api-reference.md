# API reference — `@fmaplabs/convex-slack`

## Environment variables (declared by the component)

Declared in `src/component/convex.config.ts`; bound by the app in
`app.use(slack, { env: { … } })`. All optional — none set ⇒ silent no-op.

| Var | Purpose |
| --- | --- |
| `SLACK_WEBHOOK_URL` | Incoming Webhook URL. Channel is fixed by the URL. |
| `SLACK_BOT_TOKEN` | Bot token for Web API `chat.postMessage`. **Preferred** when both are set. |
| `SLACK_DEFAULT_CHANNEL` | Default channel for the bot-token transport. |

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
| `channel` | `string?` | bot-token only; falls back to `options.defaultChannel`, then `SLACK_DEFAULT_CHANNEL` |
| `idempotencyKey` | `string?` | repeat call with same key is a no-op (returns the existing id) |
| `transport` | `"webhook" \| "botToken"?` | force a transport; default prefers the bot token |

### `listRecent(ctx, limit?)`
`ctx`: anything with `runQuery`. Returns recent `messages` rows, newest first
(`limit` default 100).

## Component functions (`components.slack.lib.*`)

Call these directly from app functions if you aren't using the client.

### `enqueue` — `mutation` → `Id<"messages"> | null`
Args: `{ text?, blocks?, channel?, idempotencyKey?, transport? }` (same shape as
`SlackMessage`). Resolves transport from env, dedupes on `idempotencyKey`, inserts a
`pending` row, schedules `send` through the workpool, returns the id (or `null`).

### `list` — `query` → `Message[]`
Args: `{ limit? }`. Newest-first.

### Internal (not part of the app-facing API)
- `send` — `internalAction` `{ id }` → `{ ok:true, httpStatus, ts? } | { ok:false, httpStatus?, error }`. Throws on retryable failure (network / 429 / 5xx).
- `onSendComplete` — `internalMutation` (workpool `onComplete`); maps the run result to the row's `status`.
- `getMessage` — `internalQuery` `{ id }` → `Message | null`.
- `markSkipped` — `internalMutation` `{ id, error? }` → patches a row to `skipped`.

## `messages` table

| field | type | |
| --- | --- | --- |
| `text` | `string?` | |
| `blocks` | `any?` | Block Kit array (pass-through) |
| `channel` | `string?` | resolved channel (bot-token only) |
| `transport` | `"webhook" \| "botToken"` | |
| `idempotencyKey` | `string?` | indexed: `by_idempotencyKey` |
| `status` | `"pending" \| "sent" \| "failed" \| "skipped"` | |
| `workId` | `string?` | correlates to the workpool item |
| `httpStatus` | `number?` | |
| `error` | `string?` | |
| `slackTs` | `string?` | `chat.postMessage` `ts` (bot-token success) |

## Pure helpers (exported from `lib.ts`, unit-testable)
- `selectTransport(env, override?) → "webhook" | "botToken" | null`
- `webhookBody(msg)` / `postMessageBody(msg)` — build the request body, omitting absent fields
- `classifyFailure(status, json?) → "retryable" | "permanent"`

## HTTP route
The component exposes `GET /last` (under the app's `httpPrefix`) returning the most
recent send as JSON.

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
