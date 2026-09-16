# S7b — Invoices, PDFs, delivery

**Depends on:** S6, S7a
**State:** done

**Amends the plan:**

- **`packages/pdf` renders with `createElement`, not JSX.** The plan chose
  `@react-pdf/renderer`; writing its components without JSX keeps the package plain
  TypeScript, so core, the web app, and the worker can import it without a JSX
  setting or React types of their own.
- **The font is embedded, as the plan asked**: Noto Sans regular and bold
  (SIL Open Font License) in `packages/pdf/fonts`, subsetted by the renderer. It
  covers Latin, Greek, Cyrillic, and Vietnamese. CJK, Arabic, and Devanagari need
  their own font added there, and are documented as not covered.
- **The client's link is a signed token, not a stored one.** An HMAC over
  `invoice:<organization>:<invoice>`, keyed for that purpose, as S5's storage links
  are. Nothing is stored, and no lookup happens before the tenant is known -- so
  `withoutTenant` still has no callers in application code.
- **A PDF is fetched through a short-lived signed link** (`invoice.download`
  returns one), the same shape as a stored file's download in S5, rather than a
  procedure returning bytes. The API's routes stay generated from the registry.
- **`invoice.email` re-sends without re-issuing.** `invoice.sent` fires once, when
  the invoice is issued; emailing it again is audited as `invoice.emailed` and emits
  nothing.
- **Billing time rounds hours to four places per line**, then prices the line as
  quantity × rate. Entries at different rates never share a line, so a rate change
  mid-project bills as two lines rather than a blended one.
- **`amount_paid_minor` and the paid, partially paid, overdue, and refunded states
  exist now** but nothing sets them: S7c's payments do. The statuses are in the
  schema from the start so that adding payments needs no migration of a table full
  of issued invoices.
- **A cancelled invoice keeps its number.** Cancelling is refused once money has
  been received against it (`invoice_has_payments`); refunds are S7c.
- **Organization settings gained billing details**: legal name, address, tax number,
  payment instructions, and default payment terms. An invoice without them still
  issues; it simply prints less.
- **Events added:** `invoice.updated` and `invoice.deleted` alongside the planned
  `invoice.created`, `sent`, `viewed`, and `cancelled`.

## Scope

In:
- Invoices: drafts priced by the same calculator as quotes, with lines from the
  catalogue, free text, or tracked time; issuing (number, issue and due dates,
  exchange rate); cancelling; and the whole thing frozen once issued.
- Raising invoices from a quote, as many as the work needs.
- Billing unbilled billable time, grouped by task, person, or entry.
- PDF rendering for invoices, with the organization's details and payment
  instructions.
- Emailing an invoice to the client with the PDF attached, and re-sending it.
- The client's link: a page with no account, its own PDF, and the view it records.
- The invoices list, invoice page, client-view Invoices section, and billing
  details in Settings → Organization.

Out:
- Payments, allocations, expenses, and the overdue sweep (S7c). The overdue styling
  on the list is computed from the due date until then.
- Quote PDFs and emailing quotes. The renderer already takes `kind: 'quote'`; only
  the procedures are missing.
- Credit notes and refunds (S7c or Phase 2), and recurring invoices (out of the MVP).
- Payment-gateway collection (out of the MVP).

## Definition of done

| # | Check | Expected |
| --- | --- | --- |
| 1 | `pnpm typecheck` · `pnpm lint` · `pnpm db:generate` | exit 0 · exit 0 · no schema changes |
| 2 | `pnpm test:unit` | exit 0, including `packages/pdf/src/render.test.ts` and the signed-link tests in `core/src/crypto.test.ts` |
| 3 | `pnpm test:integration` | exit 0, including `core/test/invoices.test.ts` (60 tests) and `db/test/document-guard.test.ts` |
| 4 | Every golden fixture, created as an invoice, read back, issued, and read back again | identical totals, line amounts, and taxes each time |
| 5 | 20 invoices issued at once, alongside 2 that fail | exactly `INV-0001` to `INV-0020` |
| 6 | Change an issued invoice's total, revert it to draft, change or add a line, or delete it, in SQL as a superuser | refused by the trigger; recording a view, a payment, or a cancellation is allowed |
| 7 | Raise an invoice from a quote, then change the service's price and archive the tax rate | the invoice still shows the agreed price and rate |
| 8 | Bill tracked time, then edit or delete one of those entries | refused with `time_entry_invoiced`; removing the line (or deleting the draft) releases the time |
| 9 | A client's link, altered by one character | not found. A draft invoice's link does not exist at all |
| 10 | `pnpm test:isolation` | exit 0, with `invoices` and `invoice_lines` discovered and probed |
| 11 | `next build`, `next start`, `pnpm worker`, then `pnpm test:e2e` | exit 0, including `invoices.spec.ts`: billing details set → time billed to a draft → issued as INV-0001 and emailed → Mailpit shows the PDF attached → the client opens the link in a fresh browser with no session, downloads the PDF, and the invoice turns to Viewed → cancelled; over the API, a quote becomes an invoice that keeps its prices, an issued invoice refuses a change (422) and deletion (409), and billed time is frozen |

## Notes for later slices

- **S7c payments** should maintain `amount_paid_minor` and `paid_at` through
  allocations, and move the status between `sent`/`viewed`, `partially_paid`, and
  `paid`. The guard trigger already allows exactly those columns to change on an
  issued invoice. The invariant to hold is `amount_due = total − Σ allocations`;
  `amountDueMinor` in the API is computed from the stored pair.
- **The overdue sweep** belongs next to quote expiry in the worker's maintenance:
  per organization, in its time zone, as a job actor. Until it exists, the list and
  the invoice page mark overdue invoices from the due date alone.
- **Quote PDFs and emails** are a small addition: `documentPdfInput(ctx, quote,
  'quote')` already works, and `quoteEmail` would mirror `invoiceEmail`.
- **`getByLabel` matches substrings**, so adding a "Legal name" field broke two
  older specs that used `getByLabel('Name')`. New labels that contain an existing
  label as a substring will do this again; prefer `{ exact: true }` in specs.
- **A client-facing page must be excluded from the client-view tab test.**
  `clients.spec.ts` used `?tab=invoices` as its example of a section that has not
  shipped; that is now a real tab, and the test uses `?tab=payments`.
- **The PDF font is read from disk at render time.** A deployment that bundles the
  server (S10's container) must copy `packages/pdf/fonts` alongside it, or every
  document will fail to render.
