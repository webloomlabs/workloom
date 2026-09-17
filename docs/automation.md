# Automation

Workloom is built to be driven by something else. Every operation is in the API,
every lifecycle change emits an event, and both are stable contracts.

## The two halves

**Events tell you something happened.** Point a webhook endpoint at n8n, Make,
Zapier, or your own service, subscribe to what you care about, and react.

**The API lets you do something about it.** Anything the interface can do.

```text
  something happens in Workloom
            │
            ▼
   webhook  ──────────→  your automation  ──────────→  Workloom API
   (signed, retried)      (n8n, a script)               (key, idempotent)
```

## Recipes

**A new lead from your website form.** POST to `/api/v1/leads` with an API key
scoped to `lead:create` and nothing else. The lead lands in the pipeline with
its source recorded.

**Tell the team when a deal is won.** Subscribe an endpoint to `deal.won` and
post to Slack. The payload carries the deal, its value, and its company.

**Chase overdue invoices.** Subscribe to `invoice.overdue` — emitted by the
nightly sweep, in your organization's own time zone — and send a reminder, or
create a task.

**Reconcile payments from your bank feed.** POST to `/api/v1/payments` with an
`Idempotency-Key` derived from the bank's transaction id. Replaying the same key
returns the original response instead of recording the money twice, which is
what makes the job safe to retry.

**Warn someone before a domain lapses.** Subscribe to
`infrastructure_asset.expiring`, emitted once per approaching renewal by the
hourly sweep — and again if the date moves, because a renewal re-arms it. The
payload carries the asset, the client it belongs to, and how many days are left.
`infrastructure_asset.expired` fires for one that got away.

**Escalate a ticket nobody has answered.** Subscribe to `ticket.created` and
compare `firstResponseDueAt` against the clock; `ticket.replied` tells you when
the client got an answer, and internal notes deliberately do not fire it.

**Know when a retainer has billed.** `billing_schedule.invoiced` carries the
schedule, the draft invoice, and the period it covers — for a reminder to issue
it, or to post the figure into a dashboard.

**A nightly copy into your warehouse.** `GET /api/v1/exports/invoices` and the
other resources; see [api.md](api.md).

## Subscribing

Endpoints are managed in **Settings → Webhooks**. Subscribe to an exact type
(`invoice.paid`), a family (`invoice.*`), or everything (`*`). A family
subscription includes types added to that family in future releases.

The full catalogue is at `GET /api/v1/webhook-event-types`, and the delivery
contract — signatures, retries, ordering — is in [webhooks.md](webhooks.md).

Two things worth knowing before you build on it:

- **Delivery is at-least-once and unordered.** Deduplicate on
  `Workloom-Event-Id`, and do not infer sequence from arrival.
- **Event names are frozen.** Types are added, never renamed or removed.

## Scheduled work inside Workloom

Some things change with the passing of time rather than because someone did
something, and the worker does them: quotes expire the day after their validity
date, and invoices go overdue the day after their due date. Both are decided per
organization, in that organization's own time zone. See
[configuration.md](configuration.md).

## Keeping it safe

Give an automation its own API key with only the scopes it needs. A key can
never exceed its owner's permissions, and revoking it stops it immediately.

Workloom will not deliver a webhook to a private or loopback address. It usually
runs inside a private network, where such a URL is a way to make the server
attack internal services. See [security.md](security.md).
