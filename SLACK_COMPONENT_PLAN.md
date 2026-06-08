# Plan — Generic Slack notification component (`@fmaplabs/convex-slack`)

## Context

The sibling plan `SLACK_LIFECYCLE_NOTIFICATIONS_PLAN.md` describes wiring Slack
notifications **directly into the fmap backend** (`packages/backend/convex/...`):
a `sendSlackNotification` action + a `notifyContractChange` helper, fired from 3
chokepoints, sending to a fixed channel via an Incoming Webhook whose URL the
action reads from `process.env.SLACK_WEBHOOK_URL`.

**This repo is not that backend.** It is the Convex *component template* renamed
to `@fmaplabs/convex-slack` ("A slack component for Convex"). Today `src/component`
and `src/client` still contain the untouched template "comments" example. The goal
is to **re-architect the integration as a reusable, publishable Slack component**
that lives here, plus a **consumer-integration guide** showing how the fmap backend
(or any Convex app) uses it.

Re-architecting forces one correction to the original plan: **a component's
functions are isolated from the host app's `process.env`** and cannot read
`SLACK_WEBHOOK_URL` directly the way an app-level action can. Convex 1.40.0 (bumped
from the template's 1.36.1 for exactly this) provides the official fix — a component
**declares its own typed env vars** in `convex.config.ts`; the app binds deployment
env vars to them at install time, and the component then reads them via `process.env`
/ the generated typed `env`. This keeps the bot token **out of function args and out
of the database** (it never travels; only the component reads it).

### Confirmed scope (decided with the user)

| Decision | Choice |
|---|---|
| Transport | **Webhook + Bot token** (Web API `chat.postMessage`) |
| State | **Log every send + idempotency-key dedupe** (component owns a `messages` table) |
| Deliverable | **Component + lifecycle example + consumer guide** |
| Credentials | **Declared component env vars** (convex bumped to 1.40.0) |

## Architecture — what is generic vs app-specific

| Layer | Lives in | Responsibility |
|---|---|---|
| **Component** (`src/component`) | this repo, published | transactional `enqueue` → scheduled non-throwing `send`; webhook + bot-token transports; `messages` log + idempotency; reads its **declared** env vars |
| **Client** (`src/client`) | this repo, published | thin `Slack` class the app instantiates with `components.slack`; composes the call and runs `enqueue` (transactionally) from an app mutation/action |
| **Example** (`example/convex`) | this repo | a worked *subscription-lifecycle* demo: declares+binds env, formats Block Kit, sends on a simulated skip/cancel |
| **Consumer code** (NOT in this repo) | fmap `packages/backend` | the app-specific `notifyContractChange` (reads the contract, builds Block Kit from the existing label mappers, picks an idempotency key) + the 3 chokepoint call sites + actor recovery — documented in the consumer guide |

The original plan's split maps cleanly: its generic `sendSlackNotification` becomes
the **component**; its app-specific `notifyContractChange` + 3 edits become
**consumer code** that calls `slack.send(...)`.

## Key technical decisions (all verified against installed convex 1.40.0)

1. **Declared component env vars.** `defineComponent(name, { env })` exists in
   1.40.0 (`node_modules/convex/.../components/index.d.ts:229`). Env validators must
   be *string-like* (`v.string()` / `v.literal` / `v.union`, optionally
   `v.optional`). Declared vars are exposed to component functions via the generated
   `env` export from `_generated/server` **and** via `process.env` (untyped). We read
   via `process.env.SLACK_*` so tests can drive them with `vi.stubEnv` (convex-test's
   `registerComponent` takes no env binding).

2. **Transactional enqueue (the core guarantee, inherited from the original plan).**
   When an app mutation calls `ctx.runMutation(components.slack.lib.enqueue, …)`, the
   component mutation runs **in the caller's transaction**. If the app mutation later
   throws, the `messages` row insert **and** the scheduled `send` roll back together —
   no notification for a rolled-back success/cancel. (This is exactly what
   `@convex-dev/resend`'s transactional `sendEmail` relies on.) Confirmable in a test:
   insert-then-throw ⇒ no row, no scheduled function.

3. **Non-throwing async send.** `enqueue` schedules `internal.lib.send` via
   `ctx.scheduler.runAfter(0, …)`; `send` does the `fetch` in `try/catch` and records
   the outcome back to the row. A send failure is isolated from the triggering
   mutation (mirrors the original plan + the existing `translate` action that already
   `fetch`es from a component action — `src/component/lib.ts:80`).

4. **Two transports, one message shape.** Message = `{ text?, blocks?, channel? }`.
   Transport chosen by configured credentials (per-call `transport` override allowed):
   - `SLACK_BOT_TOKEN` set → **Web API** `POST https://slack.com/api/chat.postMessage`
     with `Authorization: Bearer …`; requires a `channel`; **HTTP 200 even on logical
     failure**, so inspect the `ok` field; capture `ts` for future threading/updates.
   - else `SLACK_WEBHOOK_URL` set → **Incoming Webhook** `POST` (no auth header,
     channel fixed by the URL; `channel` ignored).
   - neither set → **no-op** (see #5).

5. **No-op when unconfigured.** `enqueue` checks `process.env.SLACK_BOT_TOKEN ||
   process.env.SLACK_WEBHOOK_URL`; if neither is present it **returns `null` and
   writes nothing** (no row, no schedule). Keeps dev + tests green and network-free,
   and makes per-deployment rollout safe — matching the original plan's "absent var ⇒
   silent no-op."

6. **Idempotency.** Optional `idempotencyKey` on each send; `enqueue` looks it up via
   a `by_idempotencyKey` index and skips if a row already exists. Gives exactly-once
   at the component layer (an upgrade over the original plan, which leaned only on the
   job-status chokepoint).

## Component implementation (`src/component/`)

### `convex.config.ts` — declare env (replaces the bare `defineComponent("slack")`)
```ts
import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("slack", {
  env: {
    SLACK_WEBHOOK_URL: v.optional(v.string()),
    SLACK_BOT_TOKEN: v.optional(v.string()),
    SLACK_DEFAULT_CHANNEL: v.optional(v.string()),
  },
});
```

### `schema.ts` — replace `comments` with `messages`
```ts
messages: defineTable({
  text: v.optional(v.string()),
  blocks: v.optional(v.any()),                 // arbitrary Block Kit array
  channel: v.optional(v.string()),             // resolved channel (bot-token only)
  transport: v.union(v.literal("webhook"), v.literal("botToken")),
  idempotencyKey: v.optional(v.string()),
  status: v.union(
    v.literal("pending"), v.literal("sent"),
    v.literal("failed"), v.literal("skipped"),
  ),
  attempts: v.number(),
  httpStatus: v.optional(v.number()),
  error: v.optional(v.string()),
  slackTs: v.optional(v.string()),             // chat.postMessage ts
}).index("by_idempotencyKey", ["idempotencyKey"])
```

### `lib.ts` — replace the comments CRUD with the send pipeline
Mirror the template's validator/`returns:` conventions (`src/component/lib.ts:12-30`).
- `enqueue` **(mutation)** — args `{ text?, blocks?, channel?, idempotencyKey?, transport? }`.
  1. Resolve transport from `process.env`; if unconfigured → `return null` (#5).
  2. If `idempotencyKey` set, `withIndex("by_idempotencyKey")` → return existing id if found (#6).
  3. Insert a `pending` row (`channel ?? process.env.SLACK_DEFAULT_CHANNEL`).
  4. `await ctx.scheduler.runAfter(0, internal.lib.send, { id })`; return id.
- `send` **(internalAction)** — args `{ id }`, non-throwing.
  1. `getMessage` → row. Re-read the credential for `row.transport` from `process.env`.
  2. `try` build payload (`{ text, blocks }` for webhook; `{ channel, text, blocks }` for Web API) and `fetch`. Webhook: success = HTTP 2xx. Web API: parse JSON, success = `ok === true`.
  3. `ctx.runMutation(internal.lib.markResult, { id, status, httpStatus, error?, slackTs? })`. `catch` → `markResult` `failed` + `console.error` (log-only).
- `getMessage` **(internalQuery)**, `markResult` **(internalMutation)** — bump `attempts`, set status/result.
- `list` **(query)** — recent messages for the example feed / `http.ts` (args `{ limit? }`, `returns: v.array(messageValidator)`); reuse the `schema.tables.messages.validator.extend({_id,_creationTime})` pattern.
- Small pure helpers (top of file, easy to unit-test): `selectTransport(env)`, `webhookBody(msg)`, `postMessageBody(msg)`, `parseWebApiResult(json)`.

### `http.ts` — adapt the existing `/last` route to return the most recent send (optional; keep for parity), or drop if the example doesn't need it.

## Client (`src/client/index.ts`) — replace `translate`/`exposeApi` with a `Slack` class
```ts
export class Slack {
  constructor(public component: ComponentApi, public options?: { defaultChannel?: string }) {}

  // Call from an app mutation (transactional) or action. No credentials passed —
  // the component reads its declared env vars. Returns the message id, or null if
  // Slack is unconfigured (silent no-op).
  send(ctx: RunMutationCtx, message: {
    text?: string; blocks?: unknown[]; channel?: string;
    idempotencyKey?: string; transport?: "webhook" | "botToken";
  }): Promise<string | null> {
    return ctx.runMutation(this.component.lib.enqueue, {
      ...message,
      channel: message.channel ?? this.options?.defaultChannel,
    });
  }

  listRecent(ctx: RunQueryCtx, limit?: number) {
    return ctx.runQuery(this.component.lib.list, { limit });
  }
}
```
- `RunMutationCtx`/`RunQueryCtx` = `Pick<GenericActionCtx<GenericDataModel>, "runMutation">` style aliases, as the template already does (`src/client/index.ts:109`).
- Keep a small `exposeApi(component, { auth })` exposing only `listRecent` as an authed query, if a frontend admin feed is wanted (optional).

## Drop React
A notification component ships no React. Delete `src/react/`, the `"./react"` export
and the `react`/`react-dom` peer/dev deps from `package.json`, and the `jsx` settings
are harmless to leave. (The `example/` Vite app keeps its own React — unaffected.)

## Example app (`example/convex/`) — worked subscription-lifecycle demo
- **`convex.config.ts`** — declare + bind env by reference (live, not snapshot):
```ts
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
```
- **`example.ts`** — `export const slack = new Slack(components.slack)`. A mutation
  `notifySkip(contract)` (and `notifyCancel`) that builds the lifecycle Block Kit and
  `await slack.send(ctx, { blocks, idempotencyKey })` — demonstrating the consumer
  pattern end-to-end. A `recentNotifications` query over `slack.listRecent`.
- **`schema.ts` / `http.ts` / frontend `App.tsx`** — minimal: a button to fire a
  sample skip/cancel and a list of recent sends.

### Rendered message (Block Kit target — header + 2-col fields + context)
```
⏭️  Cycle skipped
Customer:  Jane Doe (jane@acme.com)
Change:    cycle 5 (period 2026-07-04)
By:        Jane Doe — customer (storefront)
Contract:  #123  ↗ open in cargo
```
Always include a plain `text` fallback alongside `blocks` (notifications/a11y).

## Consumer-integration guide (fmap backend — documented here, implemented there)
Re-expresses the original plan's app-specific pieces as **component usage**:
1. **Install:** `app.use(slack, { env: { … app.env.SLACK_* } })` in the backend
   `convex.config.ts` (+ `defineApp({ env })`); `export const slack = new Slack(components.slack)`.
2. **`integrations/slack.ts` shrinks to `notifyContractChange` only** (the generic
   `sendSlackNotification` is now the component). It reads the contract
   (`customerName`, `customerEmail`, `nextBillingDate`, `shopifyContractId`), builds
   Block Kit via the existing pure mappers (`scheduleAuditEvent` in
   `account/scheduleJobs.ts`, `lifecycleAuditEvent` in `contracts/lifecycleJobs.ts`),
   derives an **idempotencyKey** from the chokepoint (e.g. `${contractId}:${op}:${jobId}`
   or the audit-row id), and `await slack.send(ctx, { blocks, idempotencyKey })`.
3. **3 chokepoints unchanged in spirit**, each calling `notifyContractChange` wrapped
   in **log-only `try/catch`** so it can never roll back the success/webhook patch it
   rides alongside (the original plan's hazard; `slack.send` → `enqueue` can still
   throw on validation):
   - `recordLifecycleJobSuccess` — gate `jobType ∈ {skipCycle, setNextBillingDate}`.
   - `recordScheduleJobSuccess` — gate `jobType ∈ {skipCycle, unskipCycle, rescheduleNextBillingDate}`.
   - `subscriptionContractsHandlers.ts` — on `prev !== CANCELLED && next === CANCELLED`,
     recover actor from the latest `contractAuditLogs` `cancel` row (fallback
     "Shopify admin / automatic"). Cancel stays **excluded** from the recorders.
4. **Provision:** `npx convex env set SLACK_WEBHOOK_URL <url>` (and/or
   `SLACK_BOT_TOKEN`, `SLACK_DEFAULT_CHANNEL`) on dev `affable-echidna-790`, staging
   `quiet-ladybug-240`, prod `clear-terrier-993` / `doting-mosquito-226`. Absent ⇒
   silent no-op, so deployments roll out one at a time.

## Build / tooling notes
- `package.json`: bump the `convex` devDep pin to match installed `1.40.0` (peerDep
  `^1.36.1` already satisfies); verify **`convex-test` 0.0.49** runs against 1.40.0
  and bump if needed. Update `name`/README badges if publishing under the real scope.
- Re-run **`npm run build:codegen`** after editing `convex.config.ts`/`schema.ts` — it
  regenerates `src/component/_generated` including the typed `env` export.

## Verification

**Unit (convex-test + vitest, `npm run test`).** This introduces the repo's **first
`fetch` mock** (none exists today). Pattern, per test:
```ts
vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/x");
```
Cases:
- **send (webhook):** `enqueue` → run scheduled fns (convex-test scheduled-function
  helper, with the template's `vi.useFakeTimers()`) → `fetch` called once with the
  expected body; row `status === "sent"`.
- **send (bot token):** stub `SLACK_BOT_TOKEN` + `SLACK_DEFAULT_CHANNEL`, fetch returns
  `{ ok: true, ts: "…" }`; assert Web API URL/header, `slackTs` stored. Also a
  `{ ok: false, error: "channel_not_found" }` → `status === "failed"`, `error` logged, **no throw**.
- **no-op:** both env vars unset → `enqueue` returns `null`, **no `fetch`, no row**.
- **idempotency:** two `enqueue`s with the same key → one row, one `fetch`.
- **transactional rollback:** an app mutation that `runMutation(enqueue)` then throws ⇒
  no `messages` row and no scheduled `send` (the core guarantee).

**Typecheck/build:** `npm run build:codegen && npm run typecheck` (tc=0). Example app
+ `example/convex` typecheck via the existing `typecheck` script.

**Dev-store E2E:** `npx convex env set SLACK_WEBHOOK_URL …` on the example dev
deployment, fire the sample skip/cancel from the frontend, confirm one Slack message
with correct labels; then set `SLACK_BOT_TOKEN` + a channel and confirm the Web API
path posts and records a `ts`.

## Out of scope / future
- Retries/backoff on transient `send` failures (could adopt a workpool later, as
  Resend does); v1 is at-most-once with a logged `failed` status.
- `chat.update`/threading helpers (the stored `slackTs` makes these a later add).
- Rate-limit handling (Slack ~1 msg/sec/channel) — fine for lifecycle volume; revisit
  if a caller fans out.
