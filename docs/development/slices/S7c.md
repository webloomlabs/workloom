# S7c — Payments, expenses, and the overdue sweep

**Depends on:** S7a, S7b
**State:** done

**Amends the plan:**

- **The invoice's settled status is one pure function.** `settlementStatus()`
  decides between `sent`, `viewed`, `partially_paid`, `paid`, `overdue`, and
  `refunded` from what is stored: total, amount paid, due date, and whether the
  client has opened it. Recording a payment and the nightly sweep both call it,
  so they cannot disagree, and it is unit-tested without a database.
- **`overdue` outranks `partially_paid`.** An invoice past its due date with
  anything still owing reads as overdue, because that is the list finance works
  from. `paid` outranks everything except `cancelled`.
- **`amount_paid_minor` is maintained by a database trigger**, not by the
  service. The trigger recomputes it from the allocations on every change and
  refuses an over-allocation, so `amount_due = total − Σ allocations` holds even
  against hand-written SQL. The service decides the status and emits the events.
- **A payment's currency is structurally equal to its invoice's.** The plan made
  this an MVP restriction to be documented; it is instead a composite foreign
  key. `payment_allocations` carries `currency`, and references
  `payments (organization_id, id, currency)` and
  `invoices (organization_id, id, currency)`. A mismatched allocation cannot be
  written at all, so no FX gain or loss can arise.
- **A refund is a payment with `kind = 'refund'`**, not a separate table. Its
  allocations subtract from what the invoice has been paid. This is what lets a
  wrongly paid invoice be cancelled, which S7b left blocked.
- **Expenses are priced like an invoice line**: a net amount plus a tax rate
  snapshot. Profitability (S8) costs the net amount, because the tax is
  reclaimed. A billable expense rebills onto an invoice at cost plus an optional
  markup, and freezes while it is billed -- the same rule as tracked time.
- **Expense receipts are not in this slice.** S5's attachments are project- and
  task-scoped; widening them is a schema change that belongs with the document
  handling in Phase 2. Noted below.
- **Events added:** `payment.updated`, `payment.deleted`, `expense.updated`,
  `expense.deleted`, and `invoice.refunded` alongside the planned
  `payment.recorded`, `expense.created`, `invoice.partially_paid`,
  `invoice.paid`, and `invoice.overdue`.

## Scope

In:
- Payments against a client, allocated across one or more invoices, and refunds.
- `amount_paid_minor` and the paid, partially paid, overdue, and refunded
  states, maintained from allocations.
- The overdue sweep in the worker, per organization, in its own time zone.
- Expenses: recording, categories, a project and client, billable and rebilled.
- Rebilling billable expenses onto a draft invoice, at cost or with a markup.
- The payments list, the expenses list, payment recording on the invoice page,
  and the client's Payments section.

Out:
- Credit notes as documents of their own (Phase 2). A refund records the money
  moving; it does not produce a numbered credit note.
- Payment-gateway collection, and reconciling a bank feed (out of the MVP).
- Expense receipts and approval workflow (Phase 2).
- Project profitability and the P&L view (S8), and the dashboard (S9).
- Recurring invoices (out of the MVP).

## Definition of done

| # | Check | Expected |
| --- | --- | --- |
| 1 | `pnpm typecheck` · `pnpm lint` · `pnpm db:generate` | exit 0 · exit 0 · no schema changes |
| 2 | `pnpm test:unit` | exit 0, including `settlement.test.ts` covering every status transition and the precedence between them |
| 3 | `pnpm test:integration` | exit 0, including `core/test/payments.test.ts` and `db/test/allocation-guard.test.ts` |
| 4 | After every mutation in the payments suite, assert `amount_due = total − Σ allocations`, no allocation exceeds its invoice, and no payment is over-allocated | holds on every case |
| 5 | Allocate a payment in one currency to an invoice in another, in SQL as a superuser | refused by the foreign key, not by the service |
| 6 | Over-allocate a payment, or a payment to an invoice, in SQL as a superuser | refused by the allocation trigger; `amount_paid_minor` cannot be set by hand to disagree with the allocations |
| 7 | Pay an invoice in two parts | `partially_paid` then `paid`, with `invoice.partially_paid` and `invoice.paid` emitted once each and `paid_at` set only at the end |
| 8 | Refund a paid invoice, then cancel it | status `refunded`, `amount_paid_minor` back to 0, and the cancellation no longer refused |
| 9 | Run the sweep twice over an invoice past its due date | `overdue` and one `invoice.overdue` event; the second run changes nothing. A paid or cancelled invoice is never swept |
| 10 | Bill a billable expense to a draft invoice, then edit or delete that expense | refused with `expense_invoiced`; removing the line releases it |
| 11 | `pnpm test:isolation` | exit 0, with `payments`, `payment_allocations`, and `expenses` discovered and probed |
| 12 | `next build`, `next start`, `pnpm worker`, then `pnpm test:e2e` | exit 0 (22 tests), including `payments.spec.ts`: an invoice is issued, part paid, shown with what is still owing on the client's link, paid off, and appears under Paid; a billable expense is recorded, rebilled with a markup, frozen, and freed again when its line goes; over the API, an over-allocation is refused (422) leaving nothing recorded, and a refund frees a paid invoice to be cancelled |

## What this slice found

- **A payment recorded in error had no way out.** S7b refused to cancel an
  invoice with money against it, and nothing could take that money off. A refund
  is that way out, and the path is tested end to end.
- **`paid_at` outlived its constraint.** An invoice that was paid, then refunded,
  then cancelled violated `invoices_paid_check`, which allowed the date only on a
  paid or refunded invoice. Having been paid is a fact about the past, so the
  constraint was widened rather than the date cleared (migration 0017).
- **S7b's cancellation test set `amount_paid_minor` by hand** as a stand-in for a
  payment. That is now refused by the database, and the test records a real one.
- **`getByLabel` and `getByText` match substrings.** The new payment form labels a
  field "Put against INV-0001", which made `getByText('INV-0001')` ambiguous and
  broke `invoices.spec.ts`. Same lesson as S7b's "Legal name": prefer
  `{ exact: true }`.
- **Declaring an event is not the same as emitting one.** The procedure suite
  requires every declared event to actually fire, which forced one fixture per
  settled state a payment procedure can leave an invoice in -- and showed that
  `payment.update` cannot change what any invoice has been paid, and that
  deleting a payment can never leave an invoice refunded. Both are now narrowed
  declarations rather than guesses.

## Notes for later slices

- **S8's `project_financials_v`** has everything it needs: billed comes from
  `invoice_lines`, collected from `payment_allocations`, labour cost from
  `time_entries.cost_rate_minor`, and expense cost from `expenses.amount_minor`
  (net of tax, which is reclaimed). Remember `WITH (security_invoker = true)`.
- **Expense receipts** need `attachments` widened beyond a project and a task.
  The composite foreign key means an `expense_id` column plus its own key, not a
  polymorphic owner column.
- **The sweep is the only place `overdue` is set.** An installation whose worker
  is not running will show invoices as sent past their due date. The invoice page
  and the list therefore still compute lateness from the due date for display.
