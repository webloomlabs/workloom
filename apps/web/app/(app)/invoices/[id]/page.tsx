import { minorToDecimalString, type Permission } from '@workloom/core'
import { contactList, invoiceGet, projectList, serviceList, taxRateList, type Invoice } from '@workloom/core/modules'
import { Alert, Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { InvoiceStatusBadge } from '@/components/finance/badges'
import { AddLineForm, LineControls, QuoteDetailsForm } from '@/components/finance/finance-forms'
import {
  BillTimeForm,
  CancelInvoiceControls,
  CopyLinkButton,
  DeleteInvoiceButton,
  EmailInvoiceForm,
  SendInvoiceForm,
} from '@/components/finance/invoice-forms'
import { addInvoiceLineAction, removeInvoiceLineAction, updateInvoiceAction, updateInvoiceLineAction } from '@/lib/actions/invoices'
import { formatDate, formatDateTime, todayIn } from '@/lib/format'
import { TAX_MODE_LABELS } from '@/lib/finance-labels'
import { money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Invoice · Workloom' }

export default async function InvoicePage({ params }: PageProps<'/invoices/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (p: Permission) => viewer.permissions.has(p)
  const [invoice, settings] = await Promise.all([call(invoiceGet, { id }), organizationSettings()])
  const draft = invoice.status === 'draft'
  const editable = draft && can('invoice:update')

  const [taxRates, services, contacts, projects] = editable
    ? await Promise.all([
        can('taxRate:read') ? call(taxRateList, {}) : { data: [] },
        can('service:read') ? call(serviceList, {}) : { data: [] },
        can('contact:read') ? call(contactList, { companyId: invoice.companyId, limit: 100 }) : { data: [] },
        can('project:read') ? call(projectList, { companyId: invoice.companyId, limit: 100, includeArchived: true }) : { data: [] },
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }]
  const taxChoices = taxRates.data.map((t) => ({ id: t.id, name: t.name, rate: t.rate }))
  const decimal = (minor: number) => minorToDecimalString(minor, invoice.currency)
  const contactEmail = contacts.data.find((c) => c.id === invoice.contactId)?.email ?? null
  const overdue = Boolean(invoice.dueDate && invoice.dueDate < todayIn(settings.timezone) && invoice.amountDueMinor > 0 && !['draft', 'cancelled', 'paid'].includes(invoice.status))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link href="/invoices" className="text-sm text-neutral-500 hover:underline">← Invoices</Link>
          <h1 className="text-xl font-semibold tracking-tight">{invoice.title}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500">
            <InvoiceStatusBadge status={invoice.status} overdue={overdue} />
            {invoice.number && <span className="font-medium text-neutral-800 dark:text-neutral-200">{invoice.number}</span>}
            <Link href={`/companies/${invoice.companyId}?tab=invoices`} className="hover:underline">{invoice.companyName}</Link>
            {invoice.contactName && <span>{invoice.contactName}</span>}
            {invoice.quoteId && <Link href={`/quotes/${invoice.quoteId}`} className="hover:underline">From a quote</Link>}
            <span>{TAX_MODE_LABELS[invoice.taxMode]}</span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          {!draft && <Link href={`/invoices/${invoice.id}/pdf`} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800">Download PDF</Link>}
          {draft && can('invoice:delete') && <DeleteInvoiceButton invoiceId={invoice.id} />}
        </div>
      </div>

      <StatusAlert invoice={invoice} overdue={overdue} timezone={settings.timezone} />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Lines" />
            {invoice.lines.length === 0 ? (
              <EmptyState>No lines yet.</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Description</Th>
                    <Th className="text-right">Qty</Th>
                    <Th className="text-right">Unit price</Th>
                    <Th className="text-right">Discount</Th>
                    <Th>Tax</Th>
                    <Th className="text-right">Amount</Th>
                    {editable && <Th />}
                  </tr>
                </thead>
                <tbody>
                  {invoice.lines.map((line) => (
                    <tr key={line.id}>
                      <Td>{line.description}</Td>
                      <Td className="text-right tabular-nums">{line.quantity}</Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">{money(line.unitAmountMinor, invoice.currency)}</Td>
                      <Td className="text-right tabular-nums text-neutral-600">{line.discountPercent ? `${line.discountPercent}%` : ''}</Td>
                      <Td className="whitespace-nowrap text-neutral-600">{line.taxName ? `${line.taxName} ${line.taxRate}%` : 'No tax'}</Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">{money(line.netMinor, invoice.currency)}</Td>
                      {editable && (
                        <Td>
                          <LineControls
                            documentId={invoice.id}
                            currency={invoice.currency}
                            taxRates={taxChoices}
                            save={updateInvoiceLineAction}
                            remove={removeInvoiceLineAction}
                            line={{
                              id: line.id,
                              description: line.description,
                              quantity: line.quantity,
                              unitAmount: decimal(line.unitAmountMinor),
                              discountPercent: line.discountPercent,
                              taxRateId: line.taxRateId,
                            }}
                          />
                        </Td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {editable && (
              <div className="border-t border-neutral-200 p-5 dark:border-neutral-800">
                <AddLineForm
                  documentId={invoice.id}
                  currency={invoice.currency}
                  taxRates={taxChoices}
                  add={addInvoiceLineAction}
                  services={services.data.map((s) => ({
                    id: s.id,
                    name: s.name,
                    hint: s.defaultPriceMinor !== null && s.currency === invoice.currency ? ` · ${money(s.defaultPriceMinor, s.currency)}` : '',
                  }))}
                />
              </div>
            )}
          </Card>

          {editable && can('timeEntry:read') && (
            <Card>
              <CardHeader title="Tracked time" description="Billable time nobody has invoiced yet, at the rates it was logged at." />
              <div className="p-5">
                <BillTimeForm invoiceId={invoice.id} projects={projects.data.map((p) => ({ id: p.id, name: p.name }))} taxRates={taxChoices} />
              </div>
            </Card>
          )}

          {editable ? (
            <Card>
              <CardHeader title="Details" />
              <div className="p-5">
                <QuoteDetailsForm
                  save={updateInvoiceAction}
                  contacts={contacts.data.map((c) => ({ id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(' ') }))}
                  terms={{ label: 'Payment terms (days)', value: String(invoice.paymentTermsDays) }}
                  quote={{
                    id: invoice.id,
                    title: invoice.title,
                    contactId: invoice.contactId,
                    currency: invoice.currency,
                    taxMode: invoice.taxMode,
                    validUntil: null,
                    discountPercent: invoice.discountPercent,
                    discountAmount: invoice.discountAmountMinor === null ? null : decimal(invoice.discountAmountMinor),
                    notes: invoice.notes,
                    terms: invoice.terms,
                    hasLines: invoice.lines.length > 0,
                  }}
                />
              </div>
            </Card>
          ) : (
            (invoice.notes || invoice.terms) && (
              <Card>
                <CardHeader title="Notes and terms" />
                <div className="space-y-4 p-5 text-sm">
                  {invoice.notes && <p className="whitespace-pre-wrap">{invoice.notes}</p>}
                  {invoice.terms && <p className="whitespace-pre-wrap text-neutral-600">{invoice.terms}</p>}
                </div>
              </Card>
            )
          )}
        </div>

        <div className="space-y-6">
          <Totals invoice={invoice} />
          {draft && can('invoice:send') && (
            <Card>
              <CardHeader title="Issue" description="Issuing gives the invoice its number and due date. It can no longer be changed afterwards." />
              <div className="p-5">
                <SendInvoiceForm invoiceId={invoice.id} currency={invoice.currency} baseCurrency={settings.baseCurrency} suggestedEmail={contactEmail} />
              </div>
            </Card>
          )}
          {!draft && (
            <Card>
              <CardHeader title="The client" description={invoice.emailSentAt ? `Last emailed to ${invoice.emailTo} on ${formatDateTime(invoice.emailSentAt, settings.timezone)}.` : 'Not emailed yet.'} />
              <div className="space-y-4 p-5">
                <CopyLinkButton url={invoice.publicUrl!} />
                {can('invoice:send') && invoice.status !== 'cancelled' && <EmailInvoiceForm invoiceId={invoice.id} suggestedEmail={invoice.emailTo ?? contactEmail} />}
              </div>
            </Card>
          )}
          {!draft && invoice.status !== 'cancelled' && can('invoice:cancel') && (
            <Card>
              <CardHeader title="Cancel" description="The invoice stays on the record, marked cancelled." />
              <div className="p-5"><CancelInvoiceControls invoiceId={invoice.id} /></div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusAlert({ invoice, overdue, timezone }: { invoice: Invoice; overdue: boolean; timezone: string }) {
  if (invoice.status === 'draft') return null
  if (invoice.status === 'cancelled') {
    return <Alert tone="warning">Cancelled {formatDateTime(invoice.cancelledAt, timezone)}{invoice.cancelReason ? `: ${invoice.cancelReason}` : '.'}</Alert>
  }
  const issued = `Issued ${formatDate(invoice.issueDate)}, due ${formatDate(invoice.dueDate)}`
  if (overdue) return <Alert tone="error">{issued}. Payment is overdue.</Alert>
  if (invoice.viewedAt) return <Alert tone="info">{issued}. The client opened it {formatDateTime(invoice.viewedAt, timezone)}.</Alert>
  return <Alert tone="info">{issued}. The client has not opened it yet.</Alert>
}

function Totals({ invoice }: { invoice: Invoice }) {
  const row = (label: string, minor: number, strong = false) => (
    <div className={`flex justify-between gap-4 ${strong ? 'border-t border-neutral-200 pt-2 text-base font-semibold dark:border-neutral-800' : ''}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{money(minor, invoice.currency)}</dd>
    </div>
  )
  const inclusive = invoice.taxMode === 'inclusive'
  return (
    <Card>
      <CardHeader title="Totals" />
      <dl className="space-y-2 p-5 text-sm" aria-label="Invoice totals">
        {row('Subtotal', invoice.subtotalMinor)}
        {invoice.discountMinor !== 0 && row(invoice.discountPercent ? `Discount (${invoice.discountPercent}%)` : 'Discount', -invoice.discountMinor)}
        {!inclusive && invoice.taxes.map((t) => <div key={t.taxRateId}>{row(`${t.name} ${t.rate}%`, t.taxMinor)}</div>)}
        {row('Total', invoice.totalMinor, true)}
        {inclusive &&
          invoice.taxes.map((t) => (
            <div key={t.taxRateId} className="flex justify-between gap-4 text-neutral-500">
              <dt>Includes {t.name} {t.rate}%</dt>
              <dd className="tabular-nums">{money(t.taxMinor, invoice.currency)}</dd>
            </div>
          ))}
        {invoice.amountPaidMinor > 0 && row('Paid', -invoice.amountPaidMinor)}
        {invoice.status !== 'draft' && row('Amount due', invoice.amountDueMinor, true)}
        {invoice.totalBaseMinor !== null && invoice.baseCurrency !== invoice.currency && (
          <div className="flex justify-between gap-4 text-neutral-500">
            <dt>In {invoice.baseCurrency} at {invoice.exchangeRateToBase}</dt>
            <dd className="tabular-nums">{money(invoice.totalBaseMinor, invoice.baseCurrency!)}</dd>
          </div>
        )}
      </dl>
    </Card>
  )
}
