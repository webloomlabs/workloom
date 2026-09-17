# Workloom — Roadmap

This roadmap collapses the phased plan in [project.md](project.md) (§25–26) into two delivery phases:

1. **MVP** — everything required for Webloom Labs to run the agency end-to-end on Workloom, and for another agency to self-host it.
2. **Phase 2** — everything that extends, automates, or scales that core.

The dividing line is deliberate:

> **MVP = the lifecycle works without external SaaS. Phase 2 = the lifecycle gets faster, automated, and extensible.**

If a feature is not needed to run `Lead → Client → Project → Invoice → Payment`, it belongs in Phase 2.

---

## Delivery method (applies to both phases)

Development follows **vertical slices** (§33). A module is not "done" until every layer ships:

```text
Module
├── Database schema + migration
├── API (REST + validation + permissions)
├── UI
├── Tests (unit + integration)
├── Audit logging
└── Docs
```

Ship modules in dependency order. Each completed slice must be usable and dogfooded by Webloom Labs before the next one starts.

## Architecture decisions

Settled during MVP planning; the full reasoning lives in the implementation plan.

| Decision | Choice |
| --- | --- |
| Stack | Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui, Drizzle on PostgreSQL, Better Auth |
| Tenant isolation | Postgres row-level security is the boundary, with an application wrapper for ergonomics |
| Money | Integer minor units (`bigint`) with an explicit currency per row — never floating point or `numeric` |
| Queue & rate limiting | **Postgres by default** (pg-boss); Redis is an optional driver, not a requirement |
| Email | SMTP, in the MVP — invitations need it before invoices do |

Two of these amend the specification:

- **§21 calls Redis "optional."** Rather than making it required or shipping an untested no-Redis fallback, Postgres is the *primary* queue and rate-limit backend, reusing the same `FOR UPDATE SKIP LOCKED` primitive the event outbox already needs. Redis becomes an opt-in driver for larger installations, so the default path is the well-tested one.
- **Webhooks move from last to second** in the build order (§1.7 below still describes the scope, but it is built right after identity). Shipping them late means retrofitting event emission into finished modules and re-testing them; shipping them early makes "does this module emit its events?" part of every slice's definition of done.

---

# Phase 1 — MVP

**Goal:** Webloom Labs runs its real business on Workloom. No module in the core lifecycle depends on an external SaaS tool.

**Target version:** `v0.1`

## 1.1 Foundation

The platform layer everything else sits on. Built first, but kept thin.

| Area | Scope |
| --- | --- |
| Multi-tenancy | `Organization` as the tenant boundary; every owned resource carries an org ID; enforced at the query layer, not just the UI |
| Auth | Email/password, secure sessions, password hashing, password reset |
| Users & roles | Invite users; roles: Owner, Admin, Manager, Developer, Account Manager, Finance |
| Permissions | Role-based checks enforced server-side on every API route |
| Org settings | Org profile, currency, tax defaults, date/number formats, branding basics |
| Audit log | Write path for auth events, financial changes, and client/project changes |
| Health endpoint | `/health` — app + database + migration status |

**Deliberately excluded from MVP:** SSO/OAuth login, granular per-resource permissions, custom roles, org-switching UI beyond a simple selector.

## 1.2 CRM

Entities: `Lead`, `Company`, `Contact`, `Deal`, `Activity`, `Note`.

- Lead capture and lead source
- Sales pipeline with fixed stages: New Lead → Contacted → Qualified → Proposal Sent → Negotiation → Won / Lost (built as lead statuses up to qualification, then deal stages — see [S3](docs/development/slices/S3.md))
- Deal value and expected close date
- Contact and company profiles
- Activity history and notes on every entity
- **Lead → Client conversion** (this is the connective step that makes the product not-a-CRM)

## 1.3 Clients

The unified relationship view. In MVP a client page shows: company info, contacts, projects, quotes, invoices, payments, expenses, activity history.

Tabs for support tickets, maintenance, infrastructure, and documents were Phase 2; they shipped in S11 and now count what they hold.

## 1.4 Projects, Milestones & Tasks

- Projects linked to a client (and internal projects with no client)
- Statuses: Planning, In Progress, On Hold, Review, Completed, Cancelled
- Start/end dates, budget, assigned members
- Milestones
- Tasks: assignee, priority, status, due date, labels, milestone, comments, attachments
- Task dependencies
- Project progress derived from task/milestone completion
- Internal notes vs. client-visible updates (the flag ships in MVP even though the portal that reads it does not)

**Excluded from MVP:** recurring tasks, Gantt/timeline views.

## 1.4b Time Tracking

- Timer (one running timer per user, enforced at the database level) and manual entry
- Time entries against tasks and projects, billable/non-billable
- **Rate snapshotting** — cost and billable rates resolve at entry creation (project-member override → user default → org default) and are copied onto the entry. Without this, changing someone's rate silently rewrites historical profitability.
- Weekly timesheet view and per-project rollup

## 1.4c Project Profitability

- Billed vs. collected vs. labour cost vs. expense cost vs. budget, per project
- Margin and margin percentage, reported in the organization's base currency
- Computed as a database view over time entries, expenses, and invoices — not stored columns

## 1.5 Finance

Entities: `Quote`, `Invoice`, `Payment`, `Expense`, `Service`.

- Service catalogue (name, description, pricing model, default price, billing type) — needed so quotes are not free-text
- Quotes, convertible to invoices
- Invoice lifecycle: Draft → Sent → Viewed → Partially Paid → Paid, plus Overdue / Cancelled / Refunded
- Manual payment recording (full and partial)
- Expense tracking, optionally attributed to a project
- Tax configuration and multi-currency storage
- Invoice PDF generation
- Basic financial reporting: revenue, outstanding, expenses, estimated profit

**Excluded from MVP:** recurring invoices, contracts, payment-gateway collection (Stripe/PayPal), automated dunning.

## 1.6 Dashboard

Fixed (non-configurable) layout showing: revenue, outstanding invoices, expenses, estimated profit, active projects, open tasks, upcoming deadlines, sales pipeline, recent activity.

## 1.7 API & Webhooks

Treated as a product surface, not an afterthought (§18).

- REST API covering every MVP entity
- API key authentication with scoped permissions
- Rate limiting
- Outbound webhooks with signed payloads and delivery retries
- Event names defined for the core lifecycle transitions (deal won, project completed, invoice sent, invoice paid, invoice overdue)
- OpenAPI spec published

The event catalogue is defined in MVP so the Phase 2 automation engine has something to subscribe to.

## 1.8 Self-Hosting

- `docker compose up -d` producing app + PostgreSQL + worker
- `.env.example` with every required variable documented
- Automated migrations on boot
- S3-compatible storage configuration (with local-disk fallback)
- Backup and restore documentation
- Clean-environment install tested as part of CI

## 1.9 Security & Data Portability

- Encryption at rest for sensitive secrets (API keys, integration credentials)
- CSRF protection, input validation, parameterized queries
- Secure API key generation, display-once, and rotation
- Webhook signature validation
- CSV and JSON export for clients, projects, invoices, and payments

## 1.10 Documentation

`docs/` covering: installation, configuration, architecture, development, database, API, authentication, permissions, self-hosting, backup-and-restore, contributing.

## MVP exit criteria

The MVP is complete when **all** of the following are true:

1. Webloom Labs manages real leads, clients, projects, tasks, quotes, invoices, and payments in Workloom — with no parallel spreadsheet.
2. The full workflow `Create Lead → Convert to Client → Create Project → Create Invoice → Record Payment` passes as an automated E2E test.
3. A fresh machine can self-host the app from documentation alone, with no undocumented steps.
4. Every API entity is reachable via REST with an API key, and webhooks fire for core lifecycle events.
5. Organization-level data isolation is verified by tests, not just by convention.
6. No core lifecycle function requires an external SaaS dependency.

---

# Phase 2 — Additional Features

**Goal:** extend the working core — expose it to clients, automate it, connect it to the outside world, and make it extensible.

Phase 2 items are independent of one another and can be reordered based on what dogfooding proves most painful. The grouping below is by theme, not by strict sequence.

## 2.1 Agency Operations

| Feature | Notes |
| --- | --- |
| Client portal | Clients view projects, progress, milestones, client-visible tasks, proposals, contracts, invoices, payment status, documents, tickets. Strictly honours the client-visible flag built in MVP. |
| Contracts | Contract records, templates, versioning, e-signature integration |
| Documents | **Shipped (S11).** Filed against a client, optionally a project; object storage, signed downloads, client-visible flag |
| Recurring invoices | **Shipped (S11)**, except automated sending: a schedule raises a *draft* each period and a person issues it |
| Recurring tasks | For maintenance plans and internal routines. Belongs with project templates |
| Email integration | Outbound transactional email, inbound email-to-ticket, email logging on client records |
| Notifications | In-app and email notifications; per-user preferences |
| Support & maintenance | **Shipped (S11).** Tickets with two SLA clocks, internal and client-visible replies, maintenance plans, inclusions, and visit history |

## 2.2 Infrastructure Management

The main agency-specific differentiator (§12).

- **Shipped (S11):** domains, hosting, servers, applications, certificates and
  SaaS, each with an environment, a renewal date, a renewal cost, and an hourly
  sweep that announces what is approaching and marks what has passed.
- Still to come: deployments, backup and monitoring status.
- Still to come: integrations with Cloudflare, Vercel, Coolify, GitHub/GitLab,
  VPS providers, and uptime monitoring.
- **Hard requirement, deliberately deferred:** credentials are not stored at all
  until they can be stored properly — envelope encryption, a restricted role,
  and an audit entry on every read. A `password` column added in the meantime is
  how secrets end up in a backup in plain text.

## 2.3 Automation

- Event system consuming the MVP event catalogue
- Scheduled jobs and background workers
- Workflow triggers and conditions
- Automation templates (deal won → create project + milestones + onboarding checklist; invoice overdue → reminder; domain expiring in 30 days → notify account manager)
- Deep n8n integration; Make/Zapier compatibility
- Advanced webhook management: per-event subscriptions, delivery logs, replay

## 2.4 Payments & Finance Depth

- Stripe, PayPal, and local payment provider collection
- Client-facing pay-now on invoices
- Automated payment reconciliation
- Advanced financial reports and forecasting
- Accounting integrations (Xero, QuickBooks)

## 2.5 AI Layer

Strictly optional; the product must remain fully functional with AI disabled (§16).

- Agency assistant answering natural-language questions over structured data
- Project, client, and meeting summaries
- Proposal and client-update drafting
- Project health and risk analysis
- AI agents able to query data, create tasks, draft communications, and trigger approved workflows
- All AI actions respect permissions and write to the audit log

## 2.6 Platform & Ecosystem

- Plugin system and modular integration adapters
- Developer SDK
- GraphQL API
- Public developer API and integration marketplace
- Configurable dashboards and saved views
- Granular and custom permissions; SSO
- Additional deployment targets: Coolify one-click, Kubernetes, Docker Swarm
- Observability: structured app/worker logs, background-job status, integration status, error tracking
- Hosted/managed cloud version (Starter / Business / Enterprise)

## Phase 2 guiding rule

Every Phase 2 item is admitted only if it passes the test in §41:

> **"Does this help an agency run its business better?"**

and the generalization rule from §27:

> If another digital agency is likely to hit the same problem, it is a product feature. Otherwise it stays a Webloom Labs customization.

---

# Summary

| | MVP | Phase 2 |
| --- | --- | --- |
| **Outcome** | The agency lifecycle works, self-hosted, end-to-end | The lifecycle is exposed, automated, and extensible |
| **CRM** | Leads, companies, contacts, deals, pipeline, activities | — |
| **Clients** | Profiles, contacts, activity history, and (S11) documents, tickets, maintenance | Portal |
| **Projects** | Projects, milestones, tasks, dependencies, progress, time tracking, profitability | Recurring tasks, Gantt views |
| **Finance** | Quotes, invoices, payments, expenses, services, tax, PDF, and (S11) recurring billing | Contracts, gateways, accounting |
| **Infrastructure** | (S11) Domains, hosting, servers, applications, renewals | Deployments, monitoring, provider integrations |
| **Automation** | Events defined, webhooks, API keys | Event engine, triggers, scheduling, n8n |
| **AI** | — | Assistant, summaries, generation, agents |
| **Platform** | REST API, RBAC, audit log, Docker Compose | Plugins, SDK, GraphQL, SSO, hosted version |
