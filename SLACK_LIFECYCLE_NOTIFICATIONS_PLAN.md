# Slack notifications for subscription lifecycle changes

## Context

The team wants real-time visibility in Slack when a customer subscription changes
state — **skip, unskip, reschedule, or cancel** — so support/ops can react without
watching the cargo admin. Today these events are recorded to PostHog (the analytics
"spine") and to the contract Timeline, but nothing pushes to Slack, and there is no
Slack integration anywhere in the repo.

Decisions confirmed with the user:
- **Cancel coverage:** *all* cancellations, including Shopify-origin (admin cancel,
  dunning auto-cancel), not just app-initiated ones.
- **Actor scope:** notify on *every* change regardless of who acted (customer vs
  merchant staff vs system), with the actor attributed in the message.
- **Delivery:** a Slack **Incoming Webhook** → one fixed channel, URL stored as the
  Convex env var `SLACK_WEBHOOK_URL`.

## Key design insight — two different chokepoints

`skip / unskip / reschedule` and `cancel` do **not** share a single universal
chokepoint, so they are routed separately to guarantee exactly-once delivery:

- **skip / unskip / reschedule** are app-managed (Convex-authoritative schedule; no
  Shopify call, so they emit **no** webhook). Their only chokepoint is the durable-job
  **success recorders**, which already emit the PostHog spine event + Timeline row:
  - `packages/backend/convex/contracts/lifecycleJobs.ts` → `recordLifecycleJobSuccess` (merchant/cargo)
  - `packages/backend/convex/account/scheduleJobs.ts` → `recordScheduleJobSuccess` (customer/storefront)
- **cancel** is a real Shopify `SubscriptionContract` state and can originate outside
  the app (admin / dunning), which never enqueues a job. Its only universal chokepoint
  is the mirror **status-transition in the webhook handler**:
  - `packages/backend/convex/webhooks/subscriptionContractsHandlers.ts` (patches `status → CANCELLED`, ~line 89/112)

| Event | Fires from | Rationale |
|---|---|---|
| skip / unskip / reschedule | success recorders, gated to those job types | full in-app actor
attribution; no webhook is produced |
| cancel | webhook handler, on `prev !== CANCELLED && next === CANCELLED` | catches all origins; app cancels also emit this webhook, so firing from the success recorders too would **double-send** → cancel is *excluded* there |

App-initiated cancels still get good attribution: the webhook handler recovers the
actor best-effort from the most recent `cancel` row in `contractAuditLogs` for that
contract (→ "Jane Doe — customer"); Shopify-origin cancels fall back to
"Shopify admin / automatic".

Verified: `subscriptionContractsHandlers.ts` does **not** currently call
`captureSpineEvent` or the success recorders, so the webhook is a clean, non-overlapping
hook point for cancel.

## Why a scheduled action (not a direct call)

Convex **mutations cannot `fetch`**. This is exactly why the existing `posthog.capture`
works from inside a mutation — the `@posthog/convex` component persists the event and
sends it asynchronously. For Slack we mirror that: the mutation schedules an action via
`ctx.scheduler.runAfter(0, internal.integrations.slack.sendSlackNotification, …)`. The
schedule rolls back with the mutation (no notify on a rolled-back success), and the
job-level `status==='success'` short-circuit (`startScheduleJob` / `startLifecycleJob`)
guarantees one send per success.

## New file — `packages/backend/convex/integrations/slack.ts`

Mirrors the non-throwing discipline of `integrations/posthog.ts`
(`captureSpineEvent` is the reference pattern).

- **`sendSlackNotification` (internalAction)** — performs
  `fetch(process.env.SLACK_WEBHOOK_URL, { method: 'POST', headers, body: JSON.stringify({ blocks }) })`.
  - **No-ops when `SLACK_WEBHOOK_URL` is unset** → keeps dev + the ~400 existing tests
    green and network-free; partial rollout across deployments is safe.
  - Logs (does not throw) on non-2xx; being scheduled, any failure is isolated from the
    triggering mutation.
  - Env access pattern: `process.env.SLACK_WEBHOOK_URL` — matches how
    `convex/integrations/shopify/admin.ts` reads `env.SHOPIFY_STORE_DOMAIN` (the
    generated `env` is `process.env`).
- **`notifyContractChange` (mutation-side helper, exported)** — reads the contract
  (`customerName`, `customerEmail`, `nextBillingDate`, `shopifyContractId`), composes a
  Slack Block Kit payload, and schedules the action. **Fully wrapped in try/catch
  (log-only)** so it can never roll back the success/webhook patch it rides alongside
  (the same hazard `captureSpineEvent` guards — a rollback would re-run a billing/cancel op).

Message labels reuse the existing pure mappers so Slack text matches the Timeline:
- `scheduleAuditEvent` in `account/scheduleJobs.ts` (`cycle 5`, `2026-07-04`, …)
- `lifecycleAuditEvent` in `contracts/lifecycleJobs.ts`

Example rendered message:
```
⏭️  Cycle skipped
Customer:  Jane Doe (jane@acme.com)
Change:    cycle 5 (period 2026-07-04)
By:        Jane Doe — customer (storefront)
Contract:  #123  ↗ open in cargo
```

## Edits (3 call sites, ~1 line each)

1. **`convex/contracts/lifecycleJobs.ts` → `recordLifecycleJobSuccess`**
   After the existing `captureSpineEvent(...)` block, gate on
   `jobType ∈ { skipCycle, setNextBillingDate }` (cargo has no unskip job) →
   `notifyContractChange(ctx, …)`. Cancel is intentionally excluded.
2. **`convex/account/scheduleJobs.ts` → `recordScheduleJobSuccess`**
   After its `captureSpineEvent(...)`, gate on
   `jobType ∈ { skipCycle, unskipCycle, rescheduleNextBillingDate }` →
   `notifyContractChange(ctx, …)`. Cancel (`cancelSubscription`) intentionally excluded.
3. **`convex/webhooks/subscriptionContractsHandlers.ts`**
   At the status patch, detect the `→ CANCELLED` transition
   (`existing.status !== 'CANCELLED' && normalizedStatus === 'CANCELLED'`) and call
   `notifyContractChange(ctx, …, { op: 'cancel' })`, recovering the actor from the latest
   `contractAuditLogs` `cancel` row for the contract (fallback: "Shopify admin / automatic").

## Provisioning (done once, outside the code change)

1. Create a Slack **Incoming Webhook** bound to the dedicated channel
   (Slack app → *Incoming Webhooks* → *Add New Webhook to Workspace* → pick channel) →
   copy the `https://hooks.slack.com/services/…` URL.
2. Set it per Convex deployment:
   `npx convex env set SLACK_WEBHOOK_URL <url>` for dev (`affable-echidna-790`),
   staging (`quiet-ladybug-240`), and each prod deployment in the group
   (v0 `clear-terrier-993`, v1 `doting-mosquito-226`). Absent var ⇒ silent no-op, so
   you can roll out one deployment at a time.

## Verification

- **Unit tests** (convex-test, alongside `scheduleJobs.test.ts` / lifecycle tests):
  - job-type gating: skip/unskip/reschedule success schedules a `sendSlackNotification`;
    `cancelSubscription` success does **not**.
  - cancel transition: a webhook moving `ACTIVE → CANCELLED` schedules one notification;
    a webhook with `CANCELLED → CANCELLED` (re-delivery) schedules none.
  - With `SLACK_WEBHOOK_URL` unset, the action early-returns (no fetch) — assert the
    scheduled function is a no-op so existing suites stay green.
- **Typecheck/build:** backend typecheck (expect tc=0); cargo/storefront builds are
  unaffected (backend-only change).
- **Dev-store E2E:** set `SLACK_WEBHOOK_URL` on the dev deployment, then from the
  storefront: skip a cycle, unskip it, reschedule the next billing date, and cancel —
  confirm one Slack message per action with correct labels/attribution. Then cancel a
  contract directly in **Shopify admin** and confirm the webhook path posts a cancel
  message attributed to "Shopify admin / automatic".

## Scope notes

- Only the four requested events. `pause` / `resume` flow through the same success
  recorder and would be a one-line addition later if wanted.
- Backend-only; no cargo/storefront UI changes.
- GDPR: notifications are transient (no new stored PII); the existing `schedule:*`
  GDPR-sweep follow-up is unaffected.
