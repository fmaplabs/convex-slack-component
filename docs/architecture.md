# Architecture — `@fmaplabs/convex-slack`

A reusable Convex component for durable Slack notifications. The component owns
*delivery*; the consuming app owns *what to say and when*.

## Layers

| Layer | Lives in | Responsibility |
| --- | --- | --- |
| **Client** `src/client/index.ts` | published | `Slack` class — a thin wrapper that runs the component's `enqueue`/`list` from an app mutation/action. No credentials pass through it. |
| **Component** `src/component/` | published | transactional `enqueue`; durable retried `send`; webhook + bot-token transports; `messages` log + idempotency; reads its **declared** env vars. |
| **Child workpool** | nested in the component (`sendWorkpool`) | retry/backoff + concurrency for sends; reports terminal outcome via `onComplete`. |
| **Consumer code** | the app (e.g. fmap `packages/backend`) | builds Block Kit, picks an idempotency key, calls `slack.send(...)` from its own lifecycle chokepoints. See `consumer-integration.md`. |

```
app mutation/action
   │  slack.send(ctx, { text, blocks, idempotencyKey })
   ▼
Slack (client)  ── ctx.runMutation ──▶  component.lib.enqueue   (same transaction)
                                            │ insert messages row (pending)
                                            │ pool.enqueueAction(send, { onComplete })
                                            ▼
                              sendWorkpool (child component)
                                            │ retry / backoff / concurrency
                                            ▼
                                   component.lib.send (action)
                                            │ fetch → Slack (webhook | Web API)
                                            ▼
                              component.lib.onSendComplete (mutation)
                                            │ patch row → sent | failed | skipped
```

## Key design decisions

### Components are isolated from the app's `process.env`
A component's functions cannot read the app's environment directly. The component
**declares** its env vars in `convex.config.ts`
(`defineComponent("slack", { env: { … } })`, a Convex 1.40 API), and the app **binds**
deployment vars to them by reference in `app.use(slack, { env: { … } })`. The bound
values reach the component's functions via `process.env.SLACK_*`. The bot token never
enters function args or the database.

### Durability via a nested workpool
Reliable delivery needs retries with backoff. The Convex idiom — also used by
`@convex-dev/resend` — is to nest `@convex-dev/workpool` as a child component.
`enqueue` schedules `send` through the pool with `{ onComplete, context: { id }, retry }`
instead of `ctx.scheduler.runAfter`. Pool config: `maxParallelism: 5`,
`retryActionsByDefault: true`, `defaultRetryBehavior: { maxAttempts: 4,
initialBackoffMs: 1000, base: 2 }`.

### Retry vs. permanent — encoded in `send`'s control flow
- **Retryable** (network error / HTTP 429 / HTTP 5xx, plus a few Slack `error` codes):
  `send` **throws** → the pool retries with backoff.
- **Permanent** (logical 4xx like `channel_not_found` / `invalid_auth`, webhook 4xx):
  `send` **returns** `{ ok: false, error, httpStatus }` → no wasted retries.
- **Success**: returns `{ ok: true, httpStatus, ts? }`.

`classifyFailure(status, json)` is the single, unit-tested decision point.

### Two transports, one message shape, bot token preferred
`{ text?, blocks?, channel? }` is sent either as an Incoming Webhook POST (channel fixed
by the URL) or via Web API `chat.postMessage` (`Authorization: Bearer`, channel required,
HTTP 200 even on logical failure — inspect `ok`, capture `ts`). `selectTransport(env,
override?)` prefers the bot token when both are configured; a per-call `transport`
override must still have its credential set.

### Safe-by-default: no-op when unconfigured
If neither `SLACK_BOT_TOKEN` nor `SLACK_WEBHOOK_URL` is set, `enqueue` writes nothing,
enqueues nothing, and returns `null`. Dev/test stay green and network-free, and
production can roll out one deployment at a time.

### Exactly-once at the component layer
An optional `idempotencyKey` is looked up via `by_idempotencyKey`; a repeat is skipped
and returns the existing row's id. (Slack itself exposes no idempotency key, so a
lost-ack retry can rarely double-post — acceptable for ops alerts.)

### Transactional enqueue
Because `enqueue` runs in the caller's transaction (via `ctx.runMutation` from an app
mutation), the row insert *and* the workpool enqueue roll back together if the app
mutation throws — the same guarantee `@convex-dev/resend`'s transactional `sendEmail`
relies on.

## What's intentionally out of scope
- Block Kit builder helpers — `blocks` is pass-through.
- `chat.update` / threading — `slackTs` is stored to enable this later.
- Per-channel rate-limit shaping — `maxParallelism` already throttles.
- A React surface — dropped (no UI in a notification component).
