# S7a — Money, tax, services, quotes

**Depends on:** S1, S3, S5
**State:** done

**Amends the plan:**

- **The golden fixtures are the specification** (`packages/core/src/tax/fixtures.ts`,
  42 cases). They were written by hand before the calculator. The rules in their
  header decide these cases:
  - Tax rounds once per tax rate, not per line.
  - A document discount is shared among lines with a positive net.
  - Rounded totals are apportioned to lines by largest remainder.
  - Rounding is half away from zero.
- **`add`, `subtract`, `negate`, and `compare` are not functions.** The money module
  works in `bigint`, whose operators already do this. The plan's other primitives
  exist: `multiplyByRational`, `percentage`, `convert`, and `allocate`, plus
  `apportion`, `roundDiv`, and exact decimal parsing.
- **Sent quotes are frozen by a database trigger as well as by the service.** The
  plan asked for sent-document immutability to be enforced from the first commit;
  a trigger makes it true for any SQL, including a superuser's.
- **Tax-inclusive documents** keep the invariant differently: total = subtotal −
  discount, with tax included. Exclusive documents add the tax.
- **A tax rate's percentage cannot change once any document uses it**
  (`tax_rate_in_use`). A change in the law is a new rate; the old one is archived.
- **Events were added:** `quote.created`, `quote.updated`, `quote.deleted`, and
  `service.*` and `tax_rate.*` (created, updated, archived, restored). The planned
  quote events moved from `since: 'S7'` to `S7a`. Invoice events are now `S7b`, and
  payment-driven ones (`invoice.partially_paid`, `paid`, `overdue`, `payment.recorded`,
  `expense.created`) are `S7c`.
- **Account managers and managers can read tax rates** (`taxRate:read`), because they
  write quotes. Configuring tax stays with finance, admins, and owners.
- **Accepting or declining** a quote is `quote:update`. Duplicating one is
  `quote:create`.
- **A quote is for one client.** Its contact, deal, and project must be that client's.
  Starting from a deal takes the deal's client and currency.
- **Quote expiry runs in the worker's hourly maintenance**, once per organization and
  in its time zone, as a job actor. It is audited and emits `quote.expired`. Answering
  a quote past its date is refused even before the worker has run.

## Scope

In:
- Money primitives, the tax calculator, and golden fixtures, with property tests.
- Tax rates: create, edit, archive, restore (Settings → Tax rates).
- The service catalogue, with pricing model, billing type, unit, standard price, and
  default tax (Settings → Services).
- Quotes: drafts with lines from the catalogue or free text, credits, line and
  document discounts, and exclusive or inclusive tax. Sending numbers the quote,
  captures the exchange rate, and freezes it. After that: accept or decline,
  duplicate, delete drafts, and automatic expiry.
- The quotes list, quote page, and new-quote page. "Create quote" on a deal. The client
  view's Quotes section.

Out:
- Quote PDFs and emailing them (S7b, with invoices). "Sent" records that the quote
  went to the client.
- Converting an accepted quote into an invoice (S7b).
- Configurable number prefixes and padding: the table supports them, but there is no
  API or UI yet (S10).
- Moving a deal's stage when a quote is sent or accepted (not planned).

## Definition of done

| # | Check | Expected |
| --- | --- | --- |
| 1 | `pnpm typecheck` · `pnpm lint` · `pnpm db:generate` | exit 0 · exit 0 · no schema changes |
| 2 | `pnpm test:unit` | exit 0, including `core/src/tax/calculate.test.ts` (all 42 golden fixtures; 500 random documents whose line totals, discount shares, and tax shares sum exactly) and `core/src/money/money.test.ts` (property tests for rounding, allocation, round-trips) |
| 3 | `pnpm test:integration` | exit 0, including `core/test/finance.test.ts` and `db/test/quote-guard.test.ts` |
| 4 | Every golden fixture, as a quote created through `quote.create`, read back, sent, and read back again | identical totals, line amounts, and taxes each time |
| 5 | 20 drafts sent at once, alongside 2 sends that fail | exactly `Q-0001` to `Q-0020`; the next is `Q-0021` |
| 6 | Update a sent quote's total, revert it to draft, change, add, or delete a line, or delete it, in SQL, as the app role and as a superuser | refused by the trigger; recording `accepted` is allowed |
| 7 | Delete an organization with a sent quote (with the audit-log grant; see notes) | succeeds. Fails if the trigger's cascade exemption is removed (checked) |
| 8 | `pnpm test:isolation` | exit 0, with the five new tables discovered and probed |
| 9 | `next build`, `next start`, `pnpm worker`, then `pnpm test:e2e` | exit 0, including `quotes.spec.ts`: tax rate and service added in Settings → quote from a deal → catalogue line → edited → 10% discount leaves GST on $1,350.00 and a total of $1,755.00 → sent as Q-0001 and frozen → accepted → duplicated; over the API, a fixture quote totals 1088, a sent quote refuses a change (422) and deletion (409), and a JPY quote needs its exchange rate |

## Notes for later slices

- **S7b invoices** should reuse the calculator, `issueNumber(ctx, 'invoice')`, and the
  guard trigger's pattern, including `pg_trigger_depth()` for cascades and the whole-row
  comparison. Add `invoice_lines` to `inUse` in `tax-rates.ts`. Converting a quote
  should copy its lines, including their tax snapshots, and never re-price.
- **No one can delete an organization today.** Deletes cascade with the table owner's
  rights, and the application role may not delete from `audit_logs` (S1). S10 should
  decide how a tenant is removed: an export followed by an administrator's deletion,
  most likely. `db/test/quote-guard.test.ts` grants the right temporarily to test the
  trigger.
- **List filters that name a record check it exists**, as `quote.list` now does for its
  company, deal, and project. An empty list for another organization's id passes the
  cross-tenant probe's intent only by accident.
- **A fast-check property must not return the result of `expect(...)`**; fast-check reads
  a returned value as the property's verdict. Use a block body.
- **`CardHeader` wraps.** A long action, such as filter tabs and a search box, moves below
  the title on narrow screens.
- **The running dev stack applied the new migrations by itself.** `pnpm db:migrate`
  then reported "up to date". `drizzle-kit generate --custom` creates an empty file
  first, so fill it in before the dev server restarts, or stop the dev server while
  writing policy SQL. The development database was checked afterwards: row-level
  security is on for all five tables, and both guard triggers exist.
