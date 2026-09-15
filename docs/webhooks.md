# Webhooks

Workloom sends an HTTP `POST` to your endpoint whenever something you subscribe to
happens — a deal is won, an invoice is paid, someone joins the organization.
Register endpoints under **Settings → Webhooks**, or through the API
(`POST /api/v1/webhooks`).

## The request

```http
POST /your/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: Workloom-Webhooks/1
Workloom-Event-Id: 01a0a46a-946a-71c3-ac66-fd0920d1c5e2
Workloom-Event-Type: invoice.paid
Workloom-Delivery-Id: 01a0a46b-1c02-7f4e-9a31-5b2f0c8d7e11
Workloom-Delivery-Attempt: 1
Workloom-Signature: t=1789459760,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd

{
  "id": "01a0a46a-946a-71c3-ac66-fd0920d1c5e2",
  "type": "invoice.paid",
  "version": 1,
  "occurred_at": "2026-09-15T08:42:40.123Z",
  "organization_id": "01a088e0-9437-7062-8cc6-952c2029090c",
  "actor": { "type": "user", "id": "01a088df-…", "label": "Ann Owner" },
  "data": { … }
}
```

`data` is the entity's representation in the REST API, so the
[OpenAPI document](../README.md#documentation) served at `/api/v1/openapi.json`
describes it.

Respond with any `2xx` status within **10 seconds**. Anything else — another status,
a timeout, a refused connection, or a redirect — counts as a failure. Redirects are
never followed.

## Verifying the signature

Every request is signed with your endpoint's **signing secret** (`whsec_…`), shown
once when you create the endpoint or rotate its secret. Always verify before acting
on a request: without it, anyone who learns your URL can send you fake events.

The signature header has a timestamp and one or more signatures:

```
Workloom-Signature: t=<unix seconds>,v1=<hex HMAC>[,v1=<hex HMAC>]
```

To verify:

1. Take the **raw request body**, exactly as received. Do not parse and re-serialize
   it first — whitespace and key order would change and the signature would not match.
2. Compute `HMAC-SHA256(secret, "<t>.<raw body>")` as lowercase hex.
3. Accept the request if it equals **any** of the `v1` values, compared in constant time.
4. Reject it if `t` is more than five minutes from your current time. The timestamp is
   inside the signed content, so it cannot be altered — this is what stops an
   intercepted request being replayed later.

### Node.js

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyWorkloomSignature(header, rawBody, secret, toleranceSeconds = 300) {
  const parts = header.split(',').map((part) => part.split('='))
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1])
  if (!Number.isInteger(timestamp)) return false
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest()
  return parts
    .filter(([key]) => key === 'v1')
    .some(([, value]) => {
      const candidate = Buffer.from(value, 'hex')
      return candidate.length === expected.length && timingSafeEqual(candidate, expected)
    })
}
```

### Python

```python
import hashlib, hmac, time

def verify_workloom_signature(header: str, raw_body: bytes, secret: str, tolerance: int = 300) -> bool:
    parts = [p.split("=", 1) for p in header.split(",")]
    timestamp = next((v for k, v in parts if k == "t"), None)
    if timestamp is None or abs(time.time() - int(timestamp)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(v, expected) for k, v in parts if k == "v1")
```

### n8n

Enable the Webhook node's raw-body option so the unmodified body is available, then
verify it in a following **Code** node with the Node.js function above. Verifying
against n8n's parsed JSON instead of the raw body will fail, for the reason given in
step 1. Keep the signing secret in an n8n credential rather than in the workflow.

## Rotating the secret

**Rotate signing secret** issues a new secret and keeps the previous one valid for
**24 hours**. During that window each request carries two `v1` signatures, one per
secret, so a receiver checking "any `v1` matches" keeps working throughout. Deploy the
new secret to your receiver any time within the 24 hours.

## Delivery guarantees

**At least once.** A delivery can arrive more than once — for example when your
endpoint processed a request but its response was lost. Deduplicate on
`Workloom-Event-Id`, which is identical across every attempt and every endpoint.
The request body is byte-identical across attempts too; only the signature's
timestamp changes.

**No ordering guarantee.** Retries mean a later event can arrive before an earlier
one. Use `occurred_at`, or fetch the entity's current state from the API, rather than
assuming arrival order.

**Retries.** A failed delivery is retried after roughly 15 seconds, 1 minute,
5 minutes, 30 minutes, 2 hours, 6 hours, and 12 hours — eight attempts over about
21 hours, each delay varied by up to 20% so that deliveries which failed together do
not all retry at the same instant.

**Automatic disabling.** If five deliveries in a row exhaust every retry, the
endpoint is disabled and shows why. Fix the receiver, re-enable the endpoint, and
retry any failed deliveries from its delivery log. Re-enabling resets the count.

**Test events** (`webhook.test`) go only to the endpoint they were sent from — even a
disabled one — and are not retried.

## Subscriptions

Subscribe to exact types (`invoice.paid`), whole families (`invoice.*`), or
everything (`*`). A family subscription includes event types added to that family in
future releases. The full list is at `GET /api/v1/webhook-event-types`.

Event names are a public contract: types are added, never renamed or removed. A change
to a payload that would break existing consumers ships as a new `version` of the type.

## Addresses Workloom will not deliver to

Webhook URLs must use `https://` and resolve to a public internet address. Loopback,
private (`10.0.0.0/8`, `192.168.0.0/16`, …), link-local (including cloud metadata
services at `169.254.169.254`), and other reserved ranges are refused — both when
the endpoint is saved and again at every connection, so a hostname that later
resolves to a private address is still refused.

Workloom is usually self-hosted inside a private network. Without this, anyone able
to create a webhook could make the server send requests to internal services.

For local development only, `WORKLOOM_ALLOW_PRIVATE_WEBHOOKS=true` lifts the
restriction and permits `http://`. See [Configuration](configuration.md).
