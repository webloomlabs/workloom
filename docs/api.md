# API

Everything the interface can do, the API can do. That is structural, not a
promise: both call the same service layer, and the REST routes are generated
from the same declarations the services validate against. There is no way to add
a feature to one and forget the other.

- **Base path:** `/api/v1`
- **Description:** [`openapi.json`](openapi.json), also served live at
  `GET /api/v1/openapi.json`. Generate a client from it.

## Authenticating

Create a key in **Settings → API keys**, choosing its scopes. It is shown once.

```bash
curl https://workloom.example.com/api/v1/me \
  -H "Authorization: Bearer wl_live_..."
```

A key can never do more than the person who owns it. Its scopes are intersected
with their role's permissions on **every request**, so demoting someone narrows
their keys immediately. See [authentication.md](authentication.md).

The browser session cookie also works, which is how the interface calls the API.
Cookie-authenticated writes must come from this application's own origin.

## Conventions

These are frozen for v0.1. They are expensive to change once anyone has
integrated.

**Pagination** is by cursor, over a time-sortable key. There is no offset paging.

```http
GET /api/v1/invoices?limit=50&cursor=01a0b8...
```

```json
{ "data": [ ... ], "nextCursor": "01a0b9..." }
```

Follow `nextCursor` until it is `null`.

**Errors** always have the same shape:

```json
{
  "error": {
    "code": "invoice_not_draft",
    "message": "Invoice INV-0007 has been issued, so it can no longer be changed.",
    "details": [{ "field": "title", "message": "..." }],
    "request_id": "01a0b8..."
  }
}
```

Branch on `code`, show `message`, quote `request_id` when you report a problem.

**A record belonging to another organization is `404`, never `403`** — a 403
would confirm it exists.

**Idempotency.** Any POST accepts `Idempotency-Key`. Replaying the same key
returns the original response with `Idempotent-Replayed: true`, for 24 hours.
Use it for anything you might retry:

```bash
curl -X POST .../api/v1/payments \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Authorization: Bearer wl_live_..." \
  -d '{"companyId":"...","amountMinor":150000}'
```

**Rate limits** are per organization, per actor, per class of work — reading,
writing, and expensive things like PDFs and exports. Every response carries
`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a `429`
carries `Retry-After`.

## Money

Every amount is an **integer in the currency's minor unit**, beside an explicit
`currency`. `150000` with `"AUD"` is $1,500.00. Never a float, and never
divide by 100 blindly: JPY has no minor unit and KWD has three.

Quantities, percentages, and exchange rates are exact decimal **strings**
(`"7.33"`, `"8.875"`). Parse them as decimals, not as floats.

## Exports

Every collection worth having out of the system is exportable, under the same
permission as reading it:

```bash
curl .../api/v1/exports/invoices.csv -H "Authorization: Bearer wl_live_..." -o invoices.csv
curl .../api/v1/exports/invoices      -H "Authorization: Bearer wl_live_..."   # the same, as JSON
```

Resources: `companies`, `contacts`, `leads`, `deals`, `projects`, `tasks`,
`time-entries`, `invoices`, `payments`, `expenses`.

In the CSV, amounts are written as decimals in the row's own currency — a
`totalMinor` field appears under the header `total`, as `1234.56` — because
nobody wants to divide a spreadsheet column by 100 before they can sum it. The
JSON keeps minor units. **The columns are a contract**; they are named
explicitly in the code and asserted in a test, so they will not move because a
field was renamed.

## Events

Webhooks fire for every lifecycle event. Payloads, signatures, retries and the
frozen event catalogue are in [webhooks.md](webhooks.md).

## Versioning

`/api/v1` is a path version. Types are added to the event catalogue, never
renamed or removed. `docs/openapi.json` is committed, and CI fails if it drifts
from the code — so a breaking change is something a person approved.
