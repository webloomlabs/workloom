# Slices

Work ships as vertical slices. A slice is not done when the code exists — it is
done when every layer exists: database, API, permissions, UI, tests, audit
logging, and the events it emits.

Each slice has a file here stating its **definition of done as commands that
either pass or fail**. This matters because much of the implementation is done
by AI agents, and an agent assessing its own work against prose will conclude
it is finished. A command exiting non-zero will not.

## Convention

```markdown
# S<n> — <name>

**Depends on:** S<n-1>
**Amends:** (any plan or roadmap decision this slice changed, and why)

## Scope
What is in. What is explicitly out, and which slice it belongs to instead.

## Definition of done
Numbered checks, each a command and its expected result.

## Notes
Anything a later slice needs to know — decisions taken, surprises found.
```

## Status

| Slice | State |
| --- | --- |
| [S0 — Platform skeleton](S0.md) | Done |
| [S1 — Identity & tenancy](S1.md) | Done |
| [S2 — Outbox, events, webhooks](S2.md) | Done |
| [S3 — CRM](S3.md) | Done |
| [S4 — Client view](S4.md) | Done |
| [S5 — Projects, milestones, tasks](S5.md) | Done |
| [S6 — Time tracking](S6.md) | Done |
| [S7a — Money, tax, services, quotes](S7a.md) | Done |
| [S7b — Invoices, PDFs, delivery](S7b.md) | Done |
| [S7c — Payments, expenses, and the overdue sweep](S7c.md) | Done |
| [S8 — Profitability and reporting](S8.md) | Done |
| [S9 — Dashboard](S9.md) | Done |
| [S10 — Release hardening](S10.md) | Done |
| [S11 — Support, maintenance, infrastructure, documents, recurring billing](S11.md) | Done |
| [S14 — Invoice document v2: branding, numbering, statements, due at launch](S14.md) | Done |
| [S15 — Expenses v2: receipts, drafts, categories](S15.md) | Done |
| [S16 — Recurring billing: several periods on one invoice](S16.md) | Done |
| [S17 — Project billing models, types, and budgets](S17.md) | Done |
| [S18 — Quotes into projects: alternatives, contract, statement final invoice](S18.md) | Done |
| [S19 — Receipts from Telegram, read by AI](S19.md) | Done |
| [S20 — Closing the year: books lock, audit log, income tax pack](S20.md) | Done |
| [S21 — Bank balances follow recorded money; budgets over means overspent](S21.md) | Done |
