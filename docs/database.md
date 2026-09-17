# Database

PostgreSQL 17, one database, one schema. Drizzle for the schema and queries;
migrations are plain SQL files, applied in order, on boot.

## Rules the schema keeps

**Every domain table carries `organization_id`**, including deep children like
`invoice_lines` where it is technically derivable. That redundancy buys two
things: row-level security filters locally instead of joining to a parent, and
composite foreign keys make cross-tenant parenting *structurally impossible*:

```sql
-- invoices:      UNIQUE (organization_id, id)
-- invoice_lines: FOREIGN KEY (organization_id, invoice_id)
--                  REFERENCES invoices (organization_id, id) ON DELETE CASCADE
```

The same trick carries more than tenancy. A payment allocation's foreign key
includes the **currency**, so a payment can only ever be allocated to an invoice
in the same currency — there is no such row to write.

**Money is an integer in the minor unit**, beside an explicit `currency char(3)`
on the same row. Never `numeric`: drivers return numeric as a string, and the
first `parseFloat` introduces a rounding error nobody notices until a client
disputes an invoice. Quantities and percentages *are* `numeric`, read as strings
and parsed exactly.

**Statuses are `text` with a `CHECK`**, not `pgEnum`. PostgreSQL enums cannot
have values removed or reordered without a type rewrite, and configurable
pipelines are a Phase 2 goal. The union is declared once in `packages/core` and
the CHECK is derived from it.

**Totals are stored, not computed on read.** A tax rate edited next year cannot
change what a sent invoice said. Each line keeps a snapshot of its tax's name and
rate for the same reason, and each time entry keeps the rates it was logged at.

**Deletion is selective.** `archived_at` — one column name, never also
`deleted_at` — on companies, contacts, leads, deals, projects, services and tax
rates. Financial documents are never deleted, only cancelled. Audit entries can
be neither updated nor deleted by the application; a migration revokes the
privilege.

## Tenant isolation

Every domain table has row-level security **enabled and forced**, with a policy
comparing `organization_id` against a transaction-local setting:

```sql
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices
  USING      (organization_id = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('workloom.org_id', true), '')::uuid);
```

Policies are hand-written SQL, not generated: the security boundary should not
depend on which version of a tool ran. `withTenant(orgId, fn)` is the only
sanctioned path to tenant data; it sets the value **transaction-locally**, never
at session level, because a session-level setting leaks to the next request that
borrows the pooled connection.

`user`, `session`, `account`, `verification`, `organization`, `member`,
`invitation` and `apikey` are deliberately *not* under RLS — a person is not
organization-scoped. Membership is enforced in `resolveActor`.

Full reasoning, and the enforcement, are in [architecture.md](architecture.md).

## Triggers that hold the rules the application cannot

Some invariants matter enough to live below the application:

| Trigger | Keeps |
| --- | --- |
| `workloom_quote_guard`, `workloom_invoice_guard` | An issued document never changes. Compares the whole row, so a new column is frozen without anyone listing it. |
| `workloom_settle_invoice` | `invoices.amount_paid_minor` equals the sum of its allocations, refunds subtracting, and refuses an over-allocation. |
| `workloom_invoice_paid_guard` | That column cannot be written by hand at all. |
| `workloom_expense_guard` | A rebilled expense cannot change until its invoice line goes. |

Each binds a superuser too, and each has a test that proves it by trying.

## Views

Exactly one: `project_financials_v`. It **must** be declared
`WITH (security_invoker = true)` — a view over RLS tables otherwise runs with the
view owner's privileges and silently bypasses every policy. CI checks the option
on every view and also reads each one as the wrong tenant, because an option is a
declaration and not a proof.

## Migrations

```bash
pnpm db:generate     # after changing the schema — writes a new migration
pnpm db:migrate      # apply (the app also does this on boot)
```

Migrations are numbered, forward-only, and applied under an advisory lock so
simultaneous boots cannot apply one twice. Row-level security, triggers and the
view are written by hand with `--custom`; tables and columns are generated.

CI fails if the schema and the migrations disagree — a schema change without a
migration is a deploy that works locally and fails in production.

## Looking around

```bash
docker compose exec postgres psql -U postgres workloom
```

Remember that `psql` as the superuser bypasses row-level security, so you see
every organization at once. That is fine for looking; it is exactly why the
application is forbidden from connecting that way.
