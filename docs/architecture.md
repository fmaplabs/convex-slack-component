# Architecture — `@fmaplabs/convex-slack`

A reusable Convex component for durable Slack notifications. The component owns
*delivery*; the consuming app owns *what to say and when*.

## Layers

| Layer | Lives in | Responsibility |
| --- | --- | --- |
| **Client** `src/client/index.ts` | published | `Slack` class — a thin wrapper that runs the component's `enqueue`/`list`/`listInstallations` from an app mutation/action, plus `handleInstall`/`handleOAuthRedirect` Response-shapers the app mounts in its own `http.ts`. No credentials pass through it. |
| **Component** `src/component/` | published | transactional `enqueue`; durable retried `send`; webhook + bot-token + oauth transports; OAuth install flow (`installRedirect`/`completeOAuth`); `messages` log + idempotency; `installations`/`oauthStates`; reads its **declared** env vars. |
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

### Three transports, one message shape, bot token preferred
`{ text?, blocks?, channel? }` is delivered one of three ways:
- **webhook** — Incoming Webhook POST (channel fixed by the URL).
- **botToken** — Web API `chat.postMessage` (`Authorization: Bearer`, channel required,
  HTTP 200 even on logical failure — inspect `ok`, capture `ts`).
- **oauth** — same `chat.postMessage` call, but the token is looked up *per workspace*
  from `installations` by `teamId` at delivery time (so reinstalls are picked up). The
  botToken and oauth paths share one `postMessageViaWebApi` helper.

`selectTransport(env, override?)` prefers the bot token when both single-token transports
are configured; a per-call `transport` override must still have its credential set.
`oauth` is **multi-tenant-ambiguous** (which workspace?), so it never auto-selects — it's
chosen only via an explicit override (gated on `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`),
and `enqueue` requires a `teamId` for it.

### OAuth installation — hand-rolled on the V8 runtime
`@slack/oauth`'s ergonomic surface assumes a Node `http` server (`req`/`res`) and signs
JWT state with Node `crypto`; Convex HTTP actions run in the default V8 runtime with Web
`Request`/`Response`. So the flow is hand-rolled: one redirect + one `fetch` + two tables.
`installRedirect` builds the consent URL and stores a single-use `state` nonce
(`oauthStates`, ~10-min TTL, CSRF protection); `completeOAuth` validates it, exchanges the
`code` at `oauth.v2.access`, and upserts the per-workspace bot token (`installations`,
keyed by `teamId`/`enterpriseId` so reinstalls overwrite).

### App-mounted HTTP routes (no `httpPrefix`)
The OAuth HTTP handlers run in the **app's** `httpAction` — the app owns route paths and
mounts `slack.handleInstall`/`handleOAuthRedirect` from its own `convex/http.ts` (the
`@convex-dev/resend` pattern). Because env vars are bound to the *component*, the client
stays a thin Response-shaper and delegates the credential-touching work to the two public
component **actions** above — credentials never pass through the client. This also makes
the `redirect_uri` robust: it's derived from `req.url` in a plain app httpAction (where
`req.url` is unambiguously the full external URL), stored at install, and replayed verbatim
at exchange. Only the component's **public** functions are reachable from the app via
`components.slack.lib.*`, which is why `installRedirect`/`completeOAuth` are public while
the state/installation mutations stay internal.

### Token storage is plaintext
Per-workspace bot tokens live **in plaintext** in `installations` — exactly what every
DB-backed Slack `InstallationStore` does. If your threat model needs encryption at rest,
encrypt before storage; the schema reserves `refreshToken`/`expiresAt` for future token
rotation (out of scope today — `xoxb` tokens don't expire unless rotation is opted in).

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
