# Architecture

## Shape

```
apps/web        Next.js — the UI, and the host for the public REST API
apps/worker     the outbox dispatcher and scheduled maintenance
apps/cli        administrative commands

packages/config environment schema, parsed once at boot
packages/db     schema, migrations, and the tenant boundary
packages/auth   Better Auth wiring; resolves a request into an ActorContext
packages/core   all domain logic — money, tax, permissions, events, modules
packages/jobs   queue driver interface
packages/*      emails, pdf, storage, ui
```

One constraint holds the design together: **`core` never imports `auth`.**
Domain functions receive an `ActorContext` they never construct. That is what
lets the same logic run from a Server Action, a REST handler, a background job,
and a test with a fabricated context — and it is why business logic must not
live in a transport.

Workspace packages ship TypeScript source with no build step, so `pnpm
typecheck` is the only type gate. It is a required CI job.

## Tenant isolation

Every organization's data is separated by PostgreSQL row-level security.

Application code reaches tenant data through one function:

```ts
await withTenant(organizationId, async (tx) => {
  // every query here is filtered to this organization by the database
})
```

`withTenant` opens a transaction and sets `workloom.org_id` as a
**transaction-local** setting. Every domain table carries a policy comparing
`organization_id` against it:

```sql
CREATE POLICY tenant_isolation ON invoices
  USING      (organization_id = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('workloom.org_id', true), '')::uuid);
```

Policies are hand-written SQL migrations, not generated. The security boundary
should not change shape because a code generator was upgraded.

Four details are load-bearing:

**The `nullif` is required.** Once a transaction-local setting has been used on
a connection, it does not disappear when the transaction ends — it reverts to an
*empty string*. Casting `''` to `uuid` raises, so without `nullif` a query
issued outside a tenant transaction errors on any pooled connection that
previously served one. With it, the policy compares against `NULL` and matches
nothing. This was found by the isolation suite, not by reasoning.

**The setting is transaction-local.** `set_config(..., true)` — the third
argument. A session-level `SET` would persist on the pooled connection and leak
this organization's scope into whichever request borrows that connection next.
That bug is silent, intermittent, and cross-tenant. It is also why this design
is safe under PgBouncer transaction pooling.

**Policies are `FORCE`, not just `ENABLE`.** A table's owner bypasses a merely
enabled policy, and the application owns its tables. `FORCE` subjects the owner
too, which is what allows a self-hosted install to run with a single database
role instead of a migrator/runtime split.

**The application must not be a superuser.** Superusers bypass row-level
security unconditionally, so a superuser connection has no isolation whatever
the policies say. The most likely way an install ends up in that state is a
`DATABASE_URL` pointing at whatever role the hosting platform provided. The app
therefore verifies isolation at boot and refuses to start if it is not intact.

Child tables carry `organization_id` even where it is derivable from their
parent. This lets policies filter locally rather than joining upward, and it
enables composite foreign keys that make cross-tenant parenting structurally
impossible:

```sql
-- invoices:      UNIQUE (organization_id, id)
-- invoice_lines: FOREIGN KEY (organization_id, invoice_id)
--                  REFERENCES invoices (organization_id, id) ON DELETE CASCADE
```

### What is deliberately not tenant-scoped

Better Auth's tables — `user`, `session`, `account`, `verification`,
`organization`, `member`, `invitation` — and `rate_limits`, which has no
`organization_id` at all: its key is an opaque string, and it is written on the
authentication path, sometimes before an organization is known.

A user is not org-scoped: they may belong to several organizations, and the
question "which organizations does this user belong to?" has to be answerable
before any organization context exists. Under RLS it would return nothing.
Membership is enforced in `packages/auth/resolve-actor` instead, which carries
its own test suite.

### The escape hatch

`withoutTenant(reason, fn)` exists for genuinely instance-wide work. It logs
every invocation with a stack trace, and every caller is listed here.

Cross-organization jobs **enumerate organizations and run one `withTenant`
transaction per organization**. They do not query globally and filter in
application code.

| Caller | Why |
| --- | --- |
| _(none in application code)_ | Only test setup uses it. Additions belong in this table and in review. |

The unscoped `db` handle is a separate, narrower allowlist enforced by
`eslint.config.js`: `packages/auth` (Better Auth's tables are not tenant-scoped),
`packages/core/src/rate-limit.ts`, the worker's outbox and maintenance modules,
the health route, and the boot sequence.

The worker's hourly maintenance prunes idempotency keys the documented way:
it lists organizations, then opens one `withTenant` transaction per organization.

### Authenticating API keys

API key lookup is the one query that cannot know its organization in advance —
the organization is what it is trying to discover. `api_keys` is nevertheless a
tenant table under RLS, with a second, narrower policy:

```sql
CREATE POLICY api_key_authentication ON api_keys
  FOR SELECT USING (current_setting('workloom.auth_lookup', true) = 'on');
```

`verifyApiKey` sets that flag, transaction-locally, for the length of one
lookup by key digest. Permissive policies are OR'd, so this widens `SELECT` on
one table during one query and nothing else.

A `SECURITY DEFINER` function looks like the obvious tool here and **does not
work**: `FORCE ROW LEVEL SECURITY` subjects the table owner to the policy, and
the function's owner is the application role — so the function runs straight
into the policy it was meant to step around.

### Flag-gated policies

Two jobs genuinely need to see across organizations, and each gets a second,
narrow policy that applies only while a transaction-local flag is set:

| Flag | Set only in | Grants |
| --- | --- | --- |
| `workloom.auth_lookup` | `packages/auth/src/api-keys.ts` | `SELECT` on `api_keys`, for one lookup by key digest |
| `workloom.dispatcher` | `apps/worker/src/outbox/scope.ts` | `SELECT`/`UPDATE` on `events` and `webhook_endpoints`; `SELECT`/`INSERT`/`UPDATE` on `webhook_deliveries`. No `DELETE`, nothing else |

A lint rule rejects either flag's name anywhere else. The dispatcher could instead
enumerate organizations every poll, but that is a query per organization per second
indefinitely. Deliveries reference their endpoint and event through composite keys
on `(organization_id, id)`, so even inside the flag a delivery cannot point across
organizations.

### How this is enforced

Not by convention. `packages/db/test/schema.isolation.test.ts` runs as its own
CI job and asserts, by introspecting the live database:

1. the connection is not a superuser;
2. every table with `organization_id` has RLS enabled **and** forced;
3. every such table has a policy covering all commands;
4. every such table has an index leading with `organization_id`;
5. every view is declared `WITH (security_invoker = true)`.

Point 5 is the sharpest edge in the design. A view over RLS-protected tables
runs with its *owner's* privileges by default, silently bypassing every policy —
and a test exercising a single organization still sees entirely correct data.

The checks are introspective rather than enumerated, so they cover tables that
do not exist yet: adding a tenant table without a policy fails CI without
anyone remembering to update a list. The suite includes a canary test that
creates an unprotected table and asserts it *is* reported, so the suite cannot
pass by silently checking nothing.

## Identity and permissions

`resolveActor` in `packages/auth` is the single point where a cookie session and
an API key converge into an `ActorContext`: an organization, an actor, a role,
and an effective permission set. Nothing downstream knows which was used.

**An API key never exceeds its owner.** A key's permissions are its scopes
intersected with its owner's *current* role, evaluated on every request. Demote
someone and their keys lose access immediately; remove them and their keys stop
working. Scopes only ever narrow. Keys are stored as SHA-256 digests; the secret
is shown once and cannot be recovered.

**One permission matrix.** Roles and their permissions are defined once, in
`packages/core/permissions`. Better Auth checks its own vocabulary internally
(`invitation:create`, `member:delete`), so `packages/auth/src/access-control.ts`
*derives* those grants from the matrix rather than configuring them alongside
it.

Membership changes happen inside Better Auth's endpoints, outside the procedure
registry, so they are audited through its hooks. Those hooks run after Better
Auth commits; a failed audit write is logged loudly rather than thrown, because
an audit outage that locks everyone out is worse than a visible gap.

Accepting an invitation requires a verified email. Otherwise a leaked invitation
link plus a sign-up using the invitee's address would be enough to join.

## Procedures

Every operation is declared once with `defineProcedure`: a name, a permission,
input and output schemas, and an HTTP binding. From that one declaration come
validation, the permission check, the tenant transaction, the REST route, and
the OpenAPI document. The web UI calls the same procedures through Server
Actions, so anything the UI can do is available — and audited — through the API.

- Permission is checked **before** input is parsed, so a caller who may not
  perform an operation learns nothing from its validation errors.
- `permission: 'authenticated'` is reserved for read-only operations that only
  describe the caller (`me.get`). Gating those behind a permission would stop a
  narrowly scoped key from discovering its own scope.
- Errors map deliberately. `NotFoundError` is a 404 even when the record exists
  in another organization — a 403 would confirm it exists. `DomainError` is a
  422 whose message is shown to the caller. Anything else is a 500 with the
  detail withheld and logged against the request id.
- `packages/core/test/procedures.test.ts` requires a fixture for every mutation
  in the registry and asserts each writes an audit entry. Adding a mutation
  without one fails the suite.
- The same fixtures drive a generated cross-tenant probe: any fixture input that
  references a record (`id`, `companyId`, …) is replayed by another organization
  and must fail with `NotFoundError`. Reads with a path parameter need a fixture too.

## Events and webhooks

`ctx.emit(type, data)` writes to the `events` table **inside the caller's
transaction**. It is the only way an event comes into existence. If the change
commits, the event exists; if it rolls back, it does not. There is no dual write,
and no webhook announcing something that never happened.

The worker (`apps/worker`) polls once a second:

1. **Publish.** Claim unpublished events with `FOR UPDATE SKIP LOCKED`, insert one
   `webhook_deliveries` row per matching enabled endpoint, and stamp the events
   published — in one transaction. `SKIP LOCKED` lets several workers run without
   double-publishing.
2. **Deliver.** Claim due deliveries, take a two-minute lease, and count the attempt
   *before* sending, so a worker that dies mid-request neither loses the delivery
   nor restarts its retry schedule. Sign, POST, and record the outcome.

The delivery table is the queue. What the delivery log shows is exactly what happens
next, with no second system to reconcile, and no Redis. Polling rather than
`LISTEN/NOTIFY` is deliberate: a lost notification during a reconnect would strand
events, while a missed poll is simply the next poll. `NOTIFY` can later be added to
cut latency, with polling kept as the floor.

**Every mutation declares its events.** `defineProcedure({ emits: [...] })`, and
`packages/core/test/procedures.test.ts` fails if a mutation omits the declaration,
runs without emitting what it declares, or emits something it does not declare.
`emits: []` is allowed but has to be written down.

**The catalogue is frozen** in `packages/core/src/events/catalogue.ts` and includes
events from later slices, so an integration can subscribe to `invoice.*` before
invoicing ships. Types are added, never renamed.

**SSRF.** Webhook URLs are checked when saved and again inside the HTTP client's DNS
lookup at every connection, which defeats DNS rebinding. IP-literal URLs skip DNS
entirely, so they are checked separately before connecting; the first version
missed this and the unit tests caught it. Redirects are never followed.

**Signing secrets are encrypted, not hashed** — signing needs the secret itself. AES-256-GCM
under `WORKLOOM_ENCRYPTION_KEY`, with each value recording a fingerprint of the key
that encrypted it, so the key can be rotated through `WORKLOOM_PREVIOUS_ENCRYPTION_KEYS`.

Receiver-facing behaviour — payloads, verification, retries — is in
[webhooks.md](webhooks.md).

## Side effects outside the database

A procedure's database work commits or rolls back as one transaction; storage and
email do not take part in it. `ctx.afterCommit(fn)` runs once the transaction has
committed, for effects that must not happen if the change is undone, such as deleting
a stored file. `ctx.afterRollback(fn)` undoes effects taken before the commit, such as
removing an uploaded file whose row never landed. A failing hook is logged; a commit
hook cannot fail a request whose change has already happened.

## Files

Attachments live in object storage (`packages/storage`, local disk or S3) under keys
built from ids alone. Nothing from a filename reaches a path. The only route to the
bytes is `attachment.download`, which checks permission and returns a URL valid for
five minutes: an S3 presigned URL, or `/api/files` signed over key, expiry, filename,
and content type. Every download is served as `Content-Disposition: attachment` with
`nosniff` and a sandbox CSP, so an uploaded HTML or SVG file never renders on the
application's origin.

## Idempotency

A mutation called with an `Idempotency-Key` header records the key **in the same
transaction** as the operation. A concurrent request with the same key blocks on that
insert until the first finishes, then replays its response; if the first rolled back,
the key was never recorded and the retry simply runs. There is no "in progress" state
to expire. Keys are scoped to organization **and** actor, so two integrations choosing
the same key string never receive each other's responses, and are pruned after 24 hours.

## Cross-site request forgery

The REST API accepts the browser's session cookie as well as API keys. A
cookie-authenticated `POST`, `PATCH` or `DELETE` must carry an `Origin` matching
`APP_URL`. The session cookie's `SameSite=Lax` already blocks the classic cross-site
form post; the origin check makes the guarantee explicit rather than dependent on a
cookie attribute. Requests with an API key carry no ambient credential and are exempt.
Server Actions have their own origin checking in Next.js.

## CRM

- **There is no clients table.** A client is a company with `lifecycle_stage =
  'client'`. Splitting clients from companies would force a re-parenting migration on
  every conversion, which is where CRMs lose history. Leads keep their own table,
  because enquiry forms and the API produce rows that should not clutter the company list.
- **Conversion is one transaction.** `lead.convert` creates or attaches the company,
  creates or reuses the contact (matched by email), optionally opens a deal, marks the
  lead converted, and re-files the lead's activities onto what it became. It locks the
  lead row, so concurrent conversions produce one company. It also checks the create
  permission for each record it makes, so a key scoped to `lead:convert` cannot use it
  to create deals.
- **Links are composite foreign keys** on `(organization_id, id)`, so a contact cannot
  reference another organization's company even through raw SQL.
- **Activities use nullable foreign keys, not a polymorphic `(type, id)` pair**, so every
  link is checked. A note on a deal also carries the deal's company and contact, which
  is how it reaches their timelines. An activity is visible only to someone who can
  read *every* record it is linked to, so deal notes do not reach developers through the
  company page.

### The client view

The company page is the client view: one tab per section of `CLIENT_SECTIONS` in
`packages/core/src/modules/crm/clients.ts`. Every section the specification gives a
client is declared there, each with the slice that builds it; `company.summary`
reports each as available, upcoming, or planned, with a record count, and leaves out
sections the caller cannot read. `SHIPPED_SLICES` in `packages/core/src/release.ts`
drives both this and which catalogue events are emitted, and a unit test fails if a
shipped section has nothing counting its records.

## Data-access sharp edges

- **Raw `execute()` returns strings.** Drizzle's typed queries map columns;
  ``tx.execute(sql`...`)`` does not, so timestamps arrive as strings. Comparing
  one to a `Date` coerces the `Date` to a string and compares lexicographically.
  This silently accepted expired API keys until a test caught it. Parse
  explicitly, or use the typed query builder.
- **The database handle is lazy.** Importing `@workloom/db` must not open a
  pool: a module that merely wanted a type would bind the pool to whatever
  `DATABASE_URL` was set at import time. In tests that pointed at the developer's
  own database.
- **Modules can exist more than once in a production server.** Next bundles routes
  and rendering layers separately, so a class thrown in one bundle may be a
  different object from the class caught in another. The procedure registry lives
  on `globalThis`, and the error classes in `packages/core/src/context.ts` answer
  `instanceof` from a `Symbol.for` brand. `pnpm dev` does not reproduce this.
- **Drizzle wraps driver errors.** The Postgres error — the policy or constraint
  that fired — is on `cause`. Tests unwrap before asserting, or they pass for the
  wrong reason.
- **In Zod 4, a default still applies inside `.optional()`.**
  `queryFlag.optional()` turned an omitted field into `false`, so editing a
  client-visible task quietly unpublished it. Use `optionalFlag` from
  `modules/crm/shared.ts` for fields where absent means "unchanged" or "no filter".
- **A `CardHeader` action must be able to wrap.** A header whose action held filter tabs
  and a search box was a few pixels wider than a phone. The header now wraps.
- **A screen-reader-only label escapes a scroll container that is not positioned.**
  `sr-only` is `position: absolute`; its containing block is the nearest positioned
  ancestor, not the `overflow-x-auto` box, so it can widen the page. The shared
  `Table` wrapper is `relative` for this reason.

## Time tracking

A time entry belongs to one person, one project, and optionally one of that
project's tasks. The task's foreign key includes `project_id`, as dependencies'
do, and is not cascaded: a task with time logged against it cannot be deleted,
only cancelled.

**Rates are copied onto the entry when it is created**, from the most specific
source: the person's override on the project, then their default, then the
organization's default. Billable and cost rates resolve independently, and each
entry records where each came from. Changing any rate afterwards leaves logged
time alone. Moving an entry to another project resolves its rates again, because
the old ones belong to a different project. Defaults are kept per currency and
apply only to projects in that currency; there is no exchange-rate feed. For the
same reason, a project's currency cannot change once time is logged.

**One running timer per person, per organization**, enforced by a partial unique
index on `(organization_id, user_id) WHERE started_at IS NOT NULL AND ended_at IS
NULL`. Starting a timer stops the running one inside the same transaction; a
concurrent start that loses the race fails on the index and is answered with 409.
The index is per organization because row-level security would stop one
organization from seeing, and so from stopping, a timer in another.

**Who sees what.** `timeEntry:*` covers one's own time. Other people's needs
`timeEntryAll:read`, and changing it needs `timeEntryAll:manage`; without them it
is "not found". Rates and values need `report:readFinancial` and never appear in
events. Setting default rates needs `rate:update` as well.

**Valuation.** An entry is worth `duration × rate ÷ 3600`, rounded half away from
zero once per entry, then summed. A running timer counts for nothing until it
stops. Time with no rate is reported separately rather than counted as zero.

## Money

Every monetary value is a `bigint` of minor currency units, paired with an
explicit currency column on the same row. Never a float, and never `numeric` —
the driver returns `numeric` as a string, and the first `parseFloat` introduces
a rounding error that surfaces when a client disputes an invoice.

`pg` is configured to return `int8` as a string rather than a JavaScript
number, which would lose precision above 2^53. See `packages/db/src/client.ts`.

Over the API, an amount is a JSON integer of minor units with its currency
(`"valueMinor": 1250050, "currency": "AUD"` is 12,500.50 AUD), validated to at most
2^53 − 1 on the way in. Converting between that and what a person types is string
arithmetic in `packages/core/src/money/currency.ts`, which knows each currency's
exponent: JPY has no minor unit and KWD has three.

### Arithmetic

`packages/core/src/money/money.ts` works in `bigint` throughout: intermediate
products leave the safe-integer range long before results do. Division happens
once, at the end, rounding half away from zero. Splitting a total across parts
(`allocate`, `apportion`) uses largest remainder, so the parts always sum to the
total and each is within one unit of its exact share. Quantities, percentages, and
exchange rates are exact decimal strings, never floats: `numeric` columns, parsed
to scaled integers, and accepted over the API as a string or a JSON number.

### How a document adds up

`packages/core/src/tax/calculate.ts` prices a quote (and, from S7b, an invoice). Its
rules are specified by `tax/fixtures.ts`: 42 cases written by hand before the
calculator, run against the calculator and against a quote stored and read back.
In short: line amounts round per line; a document discount is shared among lines in
proportion to their nets; tax rounds once per tax rate on that rate's total, then is
apportioned back to lines, so line totals always sum to the document total.

Totals and each line's computed amounts are **stored**, recalculated on every change
to a draft. Each line keeps a snapshot of its tax's name and rate, and a tax rate's
percentage cannot change once a document uses it.

### Issued documents

- **Numbers are gapless.** `document_sequences` holds the next number per organization
  and kind, locked `FOR UPDATE` in the transaction that issues the document. A rollback
  returns the number. Drafts have none.
- **An issued document never changes.** The service refuses, and a trigger
  (`workloom_quote_guard`, migration 0012) refuses too, even for a superuser. After
  sending, only the status and the client's answer may change, and the comparison
  covers the whole row, so a new column is frozen without being listed. Deleting a
  sent quote is refused (409). The one exemption is a cascade from deleting the
  organization.
- **The exchange rate is captured when a document is issued**, with the base currency
  at that moment and the total converted. There is no rate feed: the rate is 1 in the
  base currency, and must be given otherwise.
