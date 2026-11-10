# Security

What Workloom defends, how, and what it does not defend. Written as a review
before tagging v0.1; every item below was checked against the running code, and
the three things the review found are fixed in this release.

Report a vulnerability privately to the maintainers rather than in a public
issue.

## The threat this design is built around

Workloom is multi-tenant and self-hosted. The failure that matters most is **one
organization reading another's data** — it is unrecoverable, it is silent, and a
test that exercises a single organization will not notice it. Almost every
decision below follows from taking that seriously.

## Tenant isolation

| Control | Where |
| --- | --- |
| Row-level security, **enabled and forced**, on every table with `organization_id` | migrations `0001` onward |
| The organization set **transaction-locally**, never session-level — so a pooled connection cannot carry it to the next request | `packages/db/src/tenant.ts` |
| The application refuses to start as a database superuser, or as a role with `BYPASSRLS` | `apps/web/instrumentation.ts` |
| Boot-time self-test: policies present, forced, indexed, and a live cross-tenant probe | same |
| A CI job of its own, failing the build | `.github/workflows/ci.yml` |
| Composite foreign keys, so a child row cannot belong to a different organization than its parent | schema |
| Every view declared `WITH (security_invoker = true)`, checked **and probed as the wrong tenant** | `packages/db/test/tenant-access.isolation.test.ts` |

`withoutTenant()` — the documented escape hatch — has **no callers in
application code**. Only test setup uses it.

Cross-tenant reads answer **404, never 403**: a 403 confirms the record exists.

## Authentication and authorisation

- Passwords are handled by Better Auth and never seen by Workloom.
- API keys are stored as hashes and compared in constant time.
- **A key's permissions are `role ∩ scopes`, recomputed every request**, so it
  can never exceed its owner's and demoting them narrows it immediately.
- Permission is checked **before** input is parsed, so an unauthorised caller
  learns nothing from a validation message.
- Every registered procedure has a test asserting it refuses an actor without
  its permission.

### Setup, on a single-tenant installation

`MULTI_TENANT` is off by default, and with it off there is exactly one
unauthenticated way to create an account: the setup screen at `/setup`. It is
open until the first account exists and closed permanently afterwards, so
**the window between the stack coming up and setup being completed is a real
one** — complete it immediately, and do not expose a fresh installation to the
internet before you have.

What closes it is whether any account exists, not whether any organization
does. An owner who deletes their organization would otherwise reopen setup for
whoever reached the URL next; instead they lock themselves out.

Everything else is closed in Better Auth rather than hidden in the UI:
`sign-up/email` and `organization/create` both refuse. The only code that
creates an account without a session is
`packages/auth/src/provisioning.ts`, which is not reachable over HTTP and has
two callers, each of which authorises first.

### Resetting an organization

Settings → Organization → *Danger zone* lets the owner delete every record and
file the organization has: clients, projects, invoices, payments, banking,
documents, and the configuration (tax rates, services, numbering, API keys,
webhooks, the Telegram bot). The organization, its members and their sign-ins,
and the audit log stay; the reset is itself an audit entry, listing how many
rows went from each table.

It is the most destructive thing in the product, so it asks for more than a
session:

1. **The owner's password**, typed again. A signed-in browser left open, or a
   stolen cookie, is not enough.
2. **A six-digit code emailed to them**, valid for ten minutes, once. Five
   wrong guesses spend it. A known password is not enough either. The code is
   stored only as an HMAC.

Only `organization:delete` may ask, which is the owner alone; the role is
re-read at each step. It is not a procedure, so no API key and no REST call
can reach it, and it needs a working mail transport. All of
`packages/auth/src/organization-reset.ts`. There is no undo: take a backup
first (see [backup-and-restore.md](backup-and-restore.md)).

The database guards that keep issued invoices and closed periods from changing
stand aside for it, and for nothing else; see
[database.md](database.md#triggers-that-hold-the-rules-the-application-cannot).

## The one public surface

A client's invoice link (`/i/<token>`) is the only thing reachable without
signing in. It is an HMAC over the organization and the invoice, keyed for that
purpose alone, so a token minted for one purpose cannot be replayed as another;
nothing is stored and no lookup happens before the tenant is known.

**It is a bearer credential** — anyone holding it sees that one invoice, which
is what an emailed invoice has to be. It reaches exactly one invoice, exposes
nothing else of the organization's, is `noindex`, and a draft has no link at
all. This is a deliberate trade and is documented as one.

## Injection and forgery

| Attack | Defence |
| --- | --- |
| SQL injection | Parameterised throughout; no string-built SQL with user input |
| Cross-site request forgery | Cookie-authenticated writes require an `Origin` matching `APP_URL`; cookies are `SameSite=Lax`; API keys are exempt, carrying no ambient credential |
| Server-side request forgery via webhooks | URLs must be HTTPS and must not resolve to loopback, private, or link-local ranges — checked when saved **and again at every connection**, so a hostname that later resolves inward is still refused |
| Stored XSS via a URL field | Website fields are normalised to `http(s)` and anything else refused, because they render as links |
| **CSV injection** | A field beginning `=`, `+`, `-` or `@` is prefixed with a quote on export. A lead form is open to the internet, so this is a real path from a stranger's keyboard to a macro on an accountant's machine |
| Response splitting / header injection | Framework-handled; no raw header writes from user input |

## Secrets

- `BETTER_AUTH_SECRET` and `WORKLOOM_ENCRYPTION_KEY` are validated at boot and
  never logged.
- Webhook signing secrets are encrypted at rest with AES-256-GCM, carrying a key
  version so rotation needs no migration. `WORKLOOM_PREVIOUS_ENCRYPTION_KEYS`
  keeps old secrets readable through a rotation.
- A webhook secret and an API key are each shown **once**, at creation.
- Neither image contains a `.env`; `.dockerignore` keeps it out of the build
  context entirely.

## The Telegram bot

- **The bot decides the organization.** Each organization brings its own bot;
  an update is stored only for the organization whose bot received it — by the
  webhook's secret header (compared in constant time, per organization) or by
  that bot's own poll. The right secret at another organization's address is
  refused.
- **Groups are opt-in.** The bot acts only in groups an owner or admin approved
  with a one-time code, only on receipts from linked members, and sends the
  details privately rather than to the group.
- **A stranger can do nothing.** Only a Telegram account linked by a one-time
  code (hashed at rest, ten minutes, single use) is acted on; everyone else is
  told how to link. A link dies with the person's membership, and can be
  revoked by them or by an admin.
- **Every change is made as the person**, through the same procedures as the
  web, with their permissions — a Confirm button is checked against whoever
  pressed it — and audited with `source = telegram`.
- **The bot token** is encrypted like webhook secrets, and kept out of every
  error and log line.
- **Receipts** are held to the same rules as uploads: 10 MB, type decided by the
  bytes. Reading them with AI sends them to the configured provider
  (Anthropic, OpenAI, Google, or Groq); it is off until an owner or admin turns
  it on, and needs that provider's key on the installation.

## Webhook delivery

Signed Stripe-style: `Workloom-Signature: t=<unix>,v1=<hmac_sha256(secret,
"t.body")>`. The timestamp is inside the signed payload, so a replay is
detectable. Consumers should compare in constant time and reject old timestamps;
see [webhooks.md](webhooks.md).

## Files

Storage keys are generated, never derived from the uploaded filename, so a
filename cannot traverse a path or collide. Downloads go through a short-lived
signed URL issued after a permission check, served as an attachment with
`nosniff`. Uploads are size-limited.

## Auditability

`ctx.audit()` is called explicitly by services with what was *intended* —
`invoice.sent`, not `invoice.updated` — inside the caller's transaction. The
application role has `UPDATE` and `DELETE` revoked on `audit_logs`: an audit log
the application can rewrite is not an audit log. Every entry carries the request
id that also appears on the API response.

Since S20:

- `TRUNCATE` is revoked too, on the log and on its seals.
- Creating or deleting a money record (an invoice issued or a draft deleted, a
  payment, an expense) keeps the **whole record** on the entry (`snapshot`), so
  a deletion leaves behind what was there.
- Every entry records the **door it came in by** (`source`: web, API,
  Telegram, worker, system).
- Each finished day (UTC) is **sealed**: a SHA-256 over that day's entries,
  chained to the day before (`audit_seals`, written by the worker's hourly
  pass). Someone with direct database access could still rewrite an entry;
  `auditSeal.verify` would then report the first day that no longer matches,
  or a past day that has gained entries since it was sealed.
- **The books can be closed** through a date (`books.lock`, owners and admins,
  with a reason). Triggers then refuse to add, change, or remove invoices,
  payments, and expenses dated on or before it, or to move one into or out of
  the closed period. Reopening is audited with its reason.

## Rate limiting

Per organization, per actor, per class — reading, writing, expensive work such
as PDFs and exports, and authentication by IP and email, more tightly.

## Transport

Workloom speaks plain HTTP and expects TLS to be terminated in front of it. Once
`APP_URL` is `https://`, HSTS is sent. `X-Forwarded-For` is read for the audit
trail only, never for authorisation.

## What this review found, and fixed

1. **No security response headers at all.** The application sent none. It now
   sends a Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options`,
   `Referrer-Policy`, `Permissions-Policy`, and HSTS where there is TLS, and no
   longer advertises the framework in `X-Powered-By`.
2. **Eleven advisories against `nodemailer`**, two of them high, reachable in
   production. Upgraded to 9.1.1, which clears all of them.
3. **The worker image shipped the whole dependency tree**, including build and
   test tooling it never loads. It now installs production dependencies only,
   which removed the one remaining vulnerable package from a shipped image.

## Known limitations

- **The Content-Security-Policy allows inline scripts.** Next hydrates through
  them, and a nonce-based policy needs middleware on every request. What the
  policy buys today is that no script, style, frame or object may load from any
  other origin. Tightening it is worth doing and is not worth pretending has
  been done.
- **`pnpm audit` reports `esbuild <= 0.24.2`** through
  `better-auth → drizzle-kit → @esbuild-kit`. The advisory concerns esbuild's
  *development server*, which nothing here ever starts, and **neither shipped
  image contains that version** — the web image does not contain esbuild at all,
  and the worker image carries only 0.28.2. It is a build-time dependency of the
  migration tooling. Revisit when better-auth stops declaring drizzle-kit as a
  runtime dependency.
- **`uuid < 11.1.1`** arrives through Testcontainers, a test-only dependency
  that reaches no image.
- **No two-factor authentication**, no SSO, no session device management. Phase 2.
- **No brute-force lockout beyond rate limiting.**
- **The client invoice link does not expire.** See above; deliberate.
- **Organization deletion does not work** — the cascade requires deleting audit
  entries, which the application role may not do. Found in S7a and left as it
  is: the alternative is an application that can erase its own audit trail.
