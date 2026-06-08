# Data flow — a notification from call to recorded outcome

Traces one `slack.send(...)` through the component, including the branch points.

## Happy path

```
slack.send(ctx, { text, blocks, idempotencyKey })          [app mutation/action]
  └─ ctx.runMutation(component.lib.enqueue, …)              [runs in caller's txn]
       1. transport = selectTransport(process.env, override)
            • null  ──────────────▶ return null            (NO-OP: nothing written)
       2. idempotencyKey set & already in by_idempotencyKey?
            • yes ───────────────▶ return existing._id      (DEDUPE: no new work)
       3. channel = botToken ? (channel ?? SLACK_DEFAULT_CHANNEL) : undefined
       4. insert messages row { status: "pending", transport, … }
       5. workId = sendWorkpool.enqueueAction(send, { id },
                     { onComplete: onSendComplete, context: { id } })
       6. patch row { workId }
       └─ return id
                                   │
        sendWorkpool drives it ────┘  (concurrency ≤ 5, retry/backoff)
                                   ▼
  component.lib.send({ id })                                 [internalAction]
       row = getMessage(id)
       transport === "botToken":
            POST https://slack.com/api/chat.postMessage  (Bearer, channel required)
            • network error / 429 / 5xx ──▶ THROW           (pool retries)
            • HTTP 200 + ok:true       ──▶ return { ok:true, httpStatus, ts }
            • HTTP 200 + ok:false      ──▶ classifyFailure(status, json)
                  retryable ──▶ THROW                        (pool retries)
                  permanent ──▶ return { ok:false, error, httpStatus }
       transport === "webhook":
            POST <SLACK_WEBHOOK_URL>
            • network error / 429 / 5xx ──▶ THROW           (pool retries)
            • 2xx                       ──▶ return { ok:true, httpStatus }
            • other 4xx                 ──▶ return { ok:false, error, httpStatus }
                                   │
        workpool reports outcome ──┘
                                   ▼
  component.lib.onSendComplete({ context:{id}, result })     [internalMutation]
       result.kind === "success":
            returnValue.ok  ──▶ patch row { status:"sent", httpStatus, slackTs? }
            else            ──▶ patch row { status:"failed", httpStatus, error }
       result.kind === "failed"  (retries exhausted)
                            ──▶ patch row { status:"failed", error }
       result.kind === "canceled"
                            ──▶ patch row { status:"skipped" }
```

## The `messages` row over time

| Stage | `status` | also set |
| --- | --- | --- |
| after `enqueue` | `pending` | `transport`, `text?`, `blocks?`, `channel?`, `idempotencyKey?`, `workId` |
| webhook 2xx / Web API `ok:true` | `sent` | `httpStatus`, `slackTs?` (Web API) |
| permanent failure / retries exhausted | `failed` | `httpStatus?`, `error` |
| work canceled before running | `skipped` | — |

## Branch summary

| Condition | Result | Row |
| --- | --- | --- |
| no transport configured | `enqueue` → `null` | none written |
| `idempotencyKey` already seen | `enqueue` → existing id | unchanged |
| network / 429 / 5xx | `send` throws → retried (≤4 attempts) | `pending` → `sent`/`failed` |
| logical 4xx (`channel_not_found`, …) | `send` returns `ok:false` | `failed` (no retry) |
| app mutation throws after `enqueue` | whole txn rolls back | none written, no work |

## Transaction & retry boundaries
- **`enqueue`** is part of the caller's transaction: the row insert and the workpool
  enqueue commit/roll back together.
- **`send`** runs later, outside that transaction, under the workpool's retry/backoff.
- **`onSendComplete`** is the workpool's terminal callback — the only place a row leaves
  `pending`.
