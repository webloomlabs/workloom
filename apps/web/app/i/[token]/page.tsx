import { formatAmount } from '@workloom/core'
import { formatDocumentDate, openInvoiceLink } from '@workloom/core/modules'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** The client's own view is not a page for search engines to hold. */
export const metadata: Metadata = { title: 'Invoice', robots: { index: false, follow: false } }

/**
 * What a client sees when they open the link on their invoice: the invoice
 * itself, no account, no navigation, nothing else of the organization's.
 *
 * Holding the signed link is the authority. Opening it records that the invoice
 * has been seen.
 */
export default async function PublicInvoicePage({ params }: PageProps<'/i/[token]'>) {
  const { token } = await params
  const opened = await openInvoiceLink(token)
  if (!opened) notFound()

  const { invoice, issuer, client, dateFormat } = opened
  const money = (minor: number) => formatAmount(minor, invoice.currency)
  const date = (value: string | null) => (value ? formatDocumentDate(value, dateFormat) : '—')
  const inclusive = invoice.taxMode === 'inclusive'
  const cancelled = invoice.status === 'cancelled'

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <article className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm sm:p-10 dark:border-neutral-800 dark:bg-neutral-900">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div className="text-sm">
            <h1 className="text-lg font-semibold tracking-tight">{issuer.name}</h1>
            {issuer.address && <p className="whitespace-pre-wrap text-neutral-600 dark:text-neutral-400">{issuer.address}</p>}
            {issuer.taxNumber && <p className="text-neutral-500">{issuer.taxNumber}</p>}
          </div>
          <div className="text-right text-sm">
            <div className="text-2xl font-semibold tracking-tight">INVOICE</div>
            <div className="font-medium">{invoice.number}</div>
            <div className="mt-2 text-neutral-500">Issued {date(invoice.issueDate)}</div>
            <div className="text-neutral-500">Due {date(invoice.dueDate)}</div>
          </div>
        </header>

        {cancelled && (
          <p role="status" className="mt-6 rounded-md bg-neutral-100 px-3 py-2 text-center text-sm font-semibold tracking-widest dark:bg-neutral-800">
            CANCELLED
          </p>
        )}

        <section className="mt-8 text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Bill to</h2>
          <p className="mt-1 font-medium">{client.name}</p>
          {invoice.contactName && <p className="text-neutral-600 dark:text-neutral-400">{invoice.contactName}</p>}
          {client.address && <p className="whitespace-pre-wrap text-neutral-600 dark:text-neutral-400">{client.address}</p>}
        </section>

        <h2 className="mt-8 text-base font-semibold">{invoice.title}</h2>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-900 text-xs uppercase tracking-wide dark:border-neutral-100">
                <th className="py-2">Description</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Unit price</th>
                <th className="py-2">Tax</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
                <tr key={line.id} className="border-b border-neutral-200 dark:border-neutral-800">
                  <td className="py-2">{line.description}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{line.quantity}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(line.unitAmountMinor)}</td>
                  <td className="py-2 text-neutral-600 dark:text-neutral-400">{line.taxName ? `${line.taxName} ${line.taxRate}%` : ''}</td>
                  <td className="py-2 text-right tabular-nums">{money(line.netMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="ml-auto mt-6 max-w-xs space-y-1 text-sm">
          <Row label="Subtotal" value={money(invoice.subtotalMinor)} />
          {invoice.discountMinor !== 0 && <Row label={invoice.discountPercent ? `Discount (${invoice.discountPercent}%)` : 'Discount'} value={money(-invoice.discountMinor)} />}
          {!inclusive && invoice.taxes.map((tax) => <Row key={tax.taxRateId} label={`${tax.name} ${tax.rate}%`} value={money(tax.taxMinor)} />)}
          <div className="flex justify-between border-t border-neutral-900 pt-2 text-base font-semibold dark:border-neutral-100">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(invoice.totalMinor)}</dd>
          </div>
          {inclusive && invoice.taxes.map((tax) => <Row key={tax.taxRateId} label={`Includes ${tax.name} ${tax.rate}%`} value={money(tax.taxMinor)} />)}
          {invoice.amountPaidMinor > 0 && <Row label="Paid" value={money(-invoice.amountPaidMinor)} />}
          {invoice.amountPaidMinor > 0 && (
            <div className="flex justify-between border-t border-neutral-200 pt-2 font-semibold dark:border-neutral-800">
              <dt>Amount due</dt>
              <dd className="tabular-nums">{money(invoice.amountDueMinor)}</dd>
            </div>
          )}
        </dl>

        {issuer.paymentInstructions && !cancelled && (
          <section className="mt-8 text-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">How to pay</h2>
            <p className="mt-1 whitespace-pre-wrap">{issuer.paymentInstructions}</p>
          </section>
        )}
        {invoice.notes && (
          <section className="mt-6 text-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Notes</h2>
            <p className="mt-1 whitespace-pre-wrap">{invoice.notes}</p>
          </section>
        )}
        {invoice.terms && <p className="mt-6 whitespace-pre-wrap text-xs text-neutral-500">{invoice.terms}</p>}

        <p className="mt-8">
          <a
            href={`/i/${token}/pdf`}
            className="inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Download PDF
          </a>
        </p>
      </article>
    </main>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
