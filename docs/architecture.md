# Architecture

## Shape

```
apps/web        Next.js — the UI, and the host for the public REST API
apps/worker     background jobs, the outbox dispatcher, scheduled work
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
`packages/core/src/rate-limit.ts`, the health route, and the boot sequence.

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
- **Drizzle wraps driver errors.** The Postgres error — the policy or constraint
  that fired — is on `cause`. Tests unwrap before asserting, or they pass for the
  wrong reason.

## Money

Every monetary value is a `bigint` of minor currency units, paired with an
explicit currency column on the same row. Never a float, and never `numeric` —
the driver returns `numeric` as a string, and the first `parseFloat` introduces
a rounding error that surfaces when a client disputes an invoice.

`pg` is configured to return `int8` as a string rather than a JavaScript
number, which would lose precision above 2^53. See `packages/db/src/client.ts`.

Details of the `Money` primitive, tax calculation, and multi-currency handling
land with S7a, specified by a golden-fixture file written before the
implementation.
