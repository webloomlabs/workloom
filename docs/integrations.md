# Integrations

Workloom deliberately has **no built-in integrations** in v0.1, and depends on
no external service for anything in the core path. Leads, clients, projects,
time, quotes, invoices, payments and reporting all work with nothing but
PostgreSQL. That is an MVP exit criterion, not an accident.

What it has instead is a complete API and a complete event stream, so anything
you need to connect, you can connect today. See [automation.md](automation.md).

## What you connect yourself

| You want | Use |
| --- | --- |
| Email delivery | SMTP. Any provider. [configuration.md](configuration.md) |
| File storage | A disk, or any S3-compatible service |
| Accounting (Xero, QuickBooks) | The API and webhooks — read invoices and payments out |
| Chat notifications | A webhook endpoint |
| Forms and lead capture | `POST /api/v1/leads` with a narrowly scoped key |
| Reporting and BI | The CSV/JSON exports, or read PostgreSQL directly |
| Payment collection | Out of scope in v0.1. Record payments through the API. |

## Reading the database directly

Nothing stops you pointing a BI tool at PostgreSQL, but connect it as a **role of
its own**, not as `workloom_app`, and remember that a superuser bypasses
row-level security entirely. A read-only role that is subject to the tenant
policies will see nothing unless it sets `workloom.org_id`; a read-only role that
is not subject to them will see every organization at once. Choose deliberately.

## Planned

The client portal, contracts and e-signature, accounting integrations, and
support ticketing are Phase 2 — see [Roadmap.md](../Roadmap.md). The MVP builds
the surfaces they attach to rather than the integrations themselves: the
client-visible flag, the signed-link pattern, and the event catalogue are
already here.
