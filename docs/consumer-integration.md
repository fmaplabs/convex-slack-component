# Consumer integration guide — wiring `@fmaplabs/convex-slack` into the fmap backend

This guide is implemented **in the fmap backend** (`packages/backend`), not in this
repo. The generic sender now lives in the component; the backend only keeps the
app-specific `notifyContractChange` and the three chokepoints that call it.

> **Mental model.** The component owns *delivery* (transport, retries, logging,
> idempotency, no-op-when-unconfigured). The backend owns *what to say and when*
> (read the contract, build Block Kit, pick an idempotency key, fire from the
> right lifecycle events).

---

## 1. Install and wire up

```bash
pnpm add @fmaplabs/convex-slack
```

**`packages/backend/convex/convex.config.ts`** — declare the app's env vars and bind
them to the component **by reference** (live values, not a snapshot):

```ts
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

**One shared client** (e.g. `packages/backend/convex/integrations/slack.ts`):

```ts
import { Slack } from "@fmaplabs/convex-slack";
import { components } from "../_generated/api";

export const slack = new Slack(components.slack);
// optional: new Slack(components.slack, { defaultChannel: "#ops-billing" })
```

No credentials are passed through code. The component reads its own declared env vars
(`SLACK_BOT_TOKEN` is preferred when both it and `SLACK_WEBHOOK_URL` are set).

After editing `convex.config.ts`, run `npx convex dev` (or `codegen`) so
`components.slack` is regenerated.

---

## 2. `integrations/slack.ts` shrinks to `notifyContractChange`

The generic `sendSlackNotification` action is gone (it's the component now). What
remains is the app-specific mapper: read the contract, build Block Kit from the
existing pure label mappers, choose an idempotency key, and call `slack.send`.

```ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { slack } from "./slack"; // the shared `new Slack(...)` from step 1

/**
 * App-specific: turn a contract lifecycle change into a Slack notification.
 * Pure Block Kit construction reuses existing label mappers:
 *   - scheduleAuditEvent  (account/scheduleJobs.ts)
 *   - lifecycleAuditEvent (contracts/lifecycleJobs.ts)
 */
export async function notifyContractChange(
  ctx: MutationCtx,
  args: {
    contractId: Id<"contracts">;
    op: string;           // "skipCycle" | "setNextBillingDate" | "cancel" | ...
    actor: string;        // resolved human-readable actor
    idempotencyKey: string;
  },
): Promise<void> {
  const contract = await ctx.db.get(args.contractId);
  if (!contract) return;

  const { customerName, customerEmail, nextBillingDate, shopifyContractId } = contract;

  const { text, blocks } = buildContractBlocks({
    op: args.op,
    customerName,
    customerEmail,
    nextBillingDate,
    shopifyContractId,
    actor: args.actor,
  });

  // Transactional: this enqueue rolls back with the surrounding mutation.
  await slack.send(ctx, { text, blocks, idempotencyKey: args.idempotencyKey });
}
```

Notes:
- **Always include `text`** (plain-text fallback) alongside `blocks` for
  notifications + accessibility.
- **`idempotencyKey`** is what makes delivery exactly-once at the component layer.
  Derive it from the chokepoint so a retried job can't double-post:
  `` `${contractId}:${op}:${jobId}` `` or the audit-row id.
- `buildContractBlocks` is pure and lives next to the existing label mappers — no
  Block Kit builders are provided by the component (pass-through by design).

---

## 3. Fire from the three chokepoints (log-only `try/catch`)

Each call site wraps `notifyContractChange` in a **log-only** `try/catch` so a Slack
problem can't roll back the success/webhook patch that the chokepoint just made.

> `slack.send` → `enqueue` can still *throw* on argument-validation errors (e.g. a
> malformed Block Kit value), so the `try/catch` is load-bearing, not decorative.
> A *delivery* failure never throws here — it's retried by the workpool and recorded
> on the message row.

```ts
try {
  await notifyContractChange(ctx, { contractId, op, actor, idempotencyKey });
} catch (err) {
  console.error("slack notify failed (non-fatal)", err);
}
```

### 3a. `recordLifecycleJobSuccess`
Gate: only notify when `jobType ∈ { skipCycle, setNextBillingDate }`.

```ts
if (jobType === "skipCycle" || jobType === "setNextBillingDate") {
  try {
    await notifyContractChange(ctx, {
      contractId,
      op: jobType,
      actor,
      idempotencyKey: `${contractId}:${jobType}:${jobId}`,
    });
  } catch (err) {
    console.error("slack notify failed (non-fatal)", err);
  }
}
```

### 3b. `recordScheduleJobSuccess`
Gate: `jobType ∈ { skipCycle, unskipCycle, rescheduleNextBillingDate }`. Same
log-only wrapper; idempotency key from `${contractId}:${jobType}:${jobId}`.

### 3c. `subscriptionContractsHandlers.ts` — cancellation edge
Cancel is **excluded** from the recorders, so detect it on the state transition:
fire only on `prev !== "CANCELLED" && next === "CANCELLED"`.

Shopify cancellations often have no in-app actor, so **recover the actor**: read the
latest `contractAuditLogs` row of type `cancel` for this contract; fall back to
`"Shopify admin / automatic"` when none exists.

```ts
if (prev !== "CANCELLED" && next === "CANCELLED") {
  const lastCancel = await ctx.db
    .query("contractAuditLogs")
    .withIndex("by_contract_and_type", (q) =>
      q.eq("contractId", contractId).eq("type", "cancel"),
    )
    .order("desc")
    .first();
  const actor = lastCancel?.actor ?? "Shopify admin / automatic";

  try {
    await notifyContractChange(ctx, {
      contractId,
      op: "cancel",
      actor,
      idempotencyKey: lastCancel?._id ?? `${contractId}:cancel:${next}`,
    });
  } catch (err) {
    console.error("slack notify failed (non-fatal)", err);
  }
}
```

---

## 4. Provision per deployment

Set the env vars on each deployment with `npx convex env set`. **An absent var ⇒ a
silent no-op** (nothing written, no network), so roll out one deployment at a time.

```bash
# Webhook (simplest; channel fixed by the URL)
npx convex env set SLACK_WEBHOOK_URL "https://hooks.slack.com/services/…"

# or Bot token (preferred when set; requires a channel)
npx convex env set SLACK_BOT_TOKEN "xoxb-…"
npx convex env set SLACK_DEFAULT_CHANNEL "C0123456789"
```

Target deployments:

| Env     | Deployment                                  |
| ------- | ------------------------------------------- |
| dev     | `affable-echidna-790`                       |
| staging | `quiet-ladybug-240`                         |
| prod    | `clear-terrier-993` / `doting-mosquito-226` |

Because unconfigured deployments no-op, you can ship the code everywhere first, then
turn deployments on one at a time by setting their env vars.

---

## 5. Verify in a dev store (E2E)

> Unit tests prove the *logic* given `process.env`. They do **not** prove the
> declared-env → `process.env` wiring — only this E2E step does.

1. `npx convex env set SLACK_WEBHOOK_URL …` on the dev deployment.
2. Trigger a real skip / reschedule / cancel from the storefront or admin.
3. Confirm one Slack message with correct labels, and a `messages` row with
   `status: "sent"`.
4. Switch to the bot token: set `SLACK_BOT_TOKEN` + `SLACK_DEFAULT_CHANNEL`; trigger
   again; confirm the Web API path posts and records `slackTs`.

---

## Reference — message shape

`slack.send(ctx, message)` accepts:

| field            | type                       | notes                                             |
| ---------------- | -------------------------- | ------------------------------------------------- |
| `text`           | `string?`                  | plain-text fallback; always send one              |
| `blocks`         | `unknown[]?`               | arbitrary Block Kit (pass-through)                |
| `channel`        | `string?`                  | bot-token only; webhook channel is fixed by URL   |
| `idempotencyKey` | `string?`                  | repeat call with same key is a no-op              |
| `transport`      | `"webhook" \| "botToken"?` | force a transport; default prefers the bot token  |

Returns the message id, or `null` when no transport is configured (no-op).
