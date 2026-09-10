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
`organization_id` against it.

Three details are load-bearing:

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
`organization`, `member`, `invitation`, `apikey`.

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
| _(none yet)_ | S0 has no callers. Additions belong in this table and in review. |

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
