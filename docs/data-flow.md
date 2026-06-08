# Data flow — a notification from call to recorded outcome

Traces one `slack.send(...)` through the component, including the branch points.

## Happy path

```
slack.send(ctx, { text, blocks, idempotencyKey })          [app mutation/action]
  └─ ctx.runMutation(component.lib.enqueue, …)              [runs in caller's txn]
       1. transport = selectTransport(process.env, override)
            • null  ──────────────▶ return null            (NO-OP: nothing written)
            • oauth & no teamId ──▶ THROW                   (multi-tenant: must address a workspace)
       2. idempotencyKey set & already in by_idempotencyKey?
            • yes ───────────────▶ return existing._id      (DEDUPE: no new work)
       3. channel = webhook ? undefined : (channel ?? SLACK_DEFAULT_CHANNEL)
       4. insert messages row { status: "pending", transport, teamId?, … }
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
            token = SLACK_BOT_TOKEN  (missing ──▶ return { ok:false, "missing_bot_token" })
            └─▶ postMessageViaWebApi(token, body)            (shared with oauth)
       transport === "oauth":
            token = getInstallationToken({ teamId: row.teamId })
            • null ─────────────────────▶ return { ok:false, "no_installation" }  (no retry)
            └─▶ postMessageViaWebApi(token, body)
       postMessageViaWebApi:
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
| after `enqueue` | `pending` | `transport`, `text?`, `blocks?`, `channel?`, `teamId?` (oauth), `idempotencyKey?`, `workId` |
| webhook 2xx / Web API `ok:true` | `sent` | `httpStatus`, `slackTs?` (Web API) |
| permanent failure / retries exhausted | `failed` | `httpStatus?`, `error` |
| work canceled before running | `skipped` | — |

## Branch summary

| Condition | Result | Row |
| --- | --- | --- |
| no transport configured | `enqueue` → `null` | none written |
| `transport:"oauth"` without `teamId` | `enqueue` throws | none written |
| `idempotencyKey` already seen | `enqueue` → existing id | unchanged |
| network / 429 / 5xx | `send` throws → retried (≤4 attempts) | `pending` → `sent`/`failed` |
| logical 4xx (`channel_not_found`, …) | `send` returns `ok:false` | `failed` (no retry) |
| `oauth` with no stored installation | `send` returns `no_installation` | `failed` (no retry) |
| app mutation throws after `enqueue` | whole txn rolls back | none written, no work |

## Transaction & retry boundaries
- **`enqueue`** is part of the caller's transaction: the row insert and the workpool
  enqueue commit/roll back together.
- **`send`** runs later, outside that transaction, under the workpool's retry/backoff.
- **`onSendComplete`** is the workpool's terminal callback — the only place a row leaves
  `pending`.

## OAuth installation flow (separate from send)

How a workspace's bot token gets into `installations`. The HTTP routes are mounted by
the **app** (`convex/http.ts`); the client handlers are thin Response-shapers over two
public component actions.

```
Browser ─GET /slack/install──▶ app httpAction
  └─ slack.handleInstall(ctx, req)                           [client, app runtime]
       redirectUri = req.url with final segment → "oauth_redirect"   (query stripped)
       └─ ctx.runAction(component.lib.installRedirect, { redirectUri })
            • SLACK_CLIENT_ID/SECRET/SCOPES missing ─▶ { error }  ─▶ 500
            state = crypto.randomUUID()
            insertOAuthState { state, redirectUri, createdAt }   (oauthStates)
            └─ { location: slack.com/oauth/v2/authorize?… }
       └─ 302 Location: <location>
                                   │
Browser ── consent on Slack ───────┘
                                   ▼
Browser ─GET /slack/oauth_redirect?code&state──▶ app httpAction
  └─ slack.handleOAuthRedirect(ctx, req)                     [client, app runtime]
       • ?error=… (user denied) ─▶ 400
       • missing code/state      ─▶ 400
       └─ ctx.runAction(component.lib.completeOAuth, { code, state })
            consumeOAuthState(state)                          (single-use, ~10-min TTL)
              • miss / expired ─▶ { ok:false, "invalid_or_expired_state" }  ─▶ 400
            POST oauth.v2.access { code, client_id, client_secret, redirect_uri }
              (redirect_uri = the stored value → byte-match guaranteed)
              • !ok           ─▶ { ok:false, error }                       ─▶ 400
            upsertInstallation(parseOAuthAccessResponse(json))  (installations, keyed by team/enterprise)
            └─ { ok:true, successUrl? }
       └─ successUrl ? 302 : inline "App installed ✅" page
```

Thereafter a `send` with `transport:"oauth"` + that `teamId` resolves the stored token
via `getInstallationToken` at delivery time (so a later reinstall is picked up).
