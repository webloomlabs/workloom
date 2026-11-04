import { minorToDecimalString, type Permission } from '@workloom/core'
import { contactList, invoiceList, projectGet, projectList, quoteGet, quoteList, serviceList, taxRateList, type Quote } from '@workloom/core/modules'
import { Alert, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { InvoiceStatusBadge, QuoteStatusBadge } from '@/components/finance/badges'
import {
  AcceptQuoteForm,
  AddLineForm,
  AnswerControls,
  OfferAlternativeButton,
  QuoteDocumentControls,
  DeleteDraftButton,
  DuplicateQuoteButton,
  LineControls,
  QuoteDetailsForm,
  SendQuoteForm,
} from '@/components/finance/finance-forms'
import { InvoiceFromQuoteButton } from '@/components/finance/invoice-forms'
import { formatDate, formatDateTime } from '@/lib/format'
import { TAX_MODE_LABELS } from '@/lib/finance-labels'
import { money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Quote · Workloom' }

export default async function QuotePage({ params }: PageProps<'/quotes/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (p: Permission) => viewer.permissions.has(p)
  const [quote, settings, invoices] = await Promise.all([
    call(quoteGet, { id }),
    organizationSettings(),
    can('invoice:read') ? call(invoiceList, { quoteId: id, limit: 20 }) : { data: [] },
  ])
  const draft = quote.status === 'draft'
  const editable = draft && can('quote:update')

  const [taxRates, services, contacts] = editable
    ? await Promise.all([
        can('taxRate:read') ? call(taxRateList, {}) : { data: [] },
        can('service:read') ? call(serviceList, {}) : { data: [] },
        can('contact:read') ? call(contactList, { companyId: quote.companyId, limit: 100 }) : { data: [] },
      ])
    : [{ data: [] }, { data: [] }, { data: [] }]
  const taxChoices = taxRates.data.map((t) => ({ id: t.id, name: t.name, rate: t.rate }))
  const answering = quote.status === 'sent' && can('quote:update')
  const [clientProjects, quoteProject, options] = await Promise.all([
    answering && !quote.projectId && can('project:read') ? call(projectList, { companyId: quote.companyId, active: true, limit: 100 }) : { data: [] },
    quote.projectId && can('project:read') ? call(projectGet, { id: quote.projectId }) : null,
    quote.optionGroupId ? call(quoteList, { optionGroupId: quote.optionGroupId, limit: 20 }) : { data: [] },
  ])
  const decimal = (minor: number) => minorToDecimalString(minor, quote.currency)

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/quotes" className="text-sm text-muted hover:underline">← Quotes</Link>}
        title={quote.title}
        description={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <QuoteStatusBadge status={quote.status} />
            {quote.number && <span className="font-medium text-ink">{quote.number}</span>}
            <Link href={`/companies/${quote.companyId}?tab=quotes`} className="hover:underline">{quote.companyName}</Link>
            {quote.contactName && <span>{quote.contactName}</span>}
            {quote.dealId && <Link href={`/deals/${quote.dealId}`} className="hover:underline">View deal</Link>}
            {quote.projectId && <Link href={`/projects/${quote.projectId}?tab=quotes`} className="hover:underline">{quoteProject?.name ?? 'Project'}</Link>}
            {quote.optionLabel && <span className="font-medium text-ink">{quote.optionLabel}</span>}
            <span>{TAX_MODE_LABELS[quote.taxMode]}</span>
          </div>
        }
        actions={
          <div className="flex items-start gap-2">
            {can('quote:create') && (quote.status === 'draft' || quote.status === 'sent') && <OfferAlternativeButton quoteId={quote.id} />}
            {can('quote:create') && <DuplicateQuoteButton quoteId={quote.id} />}
            {draft && can('quote:delete') && <DeleteDraftButton quoteId={quote.id} />}
          </div>
        }
      />

      <StatusAlert quote={quote} timezone={settings.timezone} />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Lines" />
            {quote.lines.length === 0 ? (
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
                  {quote.lines.map((line) => (
                    <Tr key={line.id}>
                      <Td>
                        <div className="font-medium">{line.description}</div>
                        {(line.detail || line.billingType) && (
                          <div className="text-xs text-muted">
                            {[line.detail, line.billingType === 'one_off' ? 'One-time' : line.billingType === 'recurring' ? 'Recurring' : null].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">{line.quantity}</Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">{money(line.unitAmountMinor, quote.currency)}</Td>
                      <Td className="text-right tabular-nums text-muted">{line.discountPercent ? `${line.discountPercent}%` : ''}</Td>
                      <Td className="whitespace-nowrap text-muted">{line.taxName ? `${line.taxName} ${line.taxRate}%` : 'No tax'}</Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">{money(line.netMinor, quote.currency)}</Td>
                      {editable && (
                        <Td>
                          <LineControls
                            documentId={quote.id}
                            currency={quote.currency}
                            taxRates={taxChoices}
                            line={{ id: line.id, description: line.description, detail: line.detail, billingType: line.billingType, quantity: line.quantity, unitAmount: decimal(line.unitAmountMinor), discountPercent: line.discountPercent, taxRateId: line.taxRateId }}
                          />
                        </Td>
                      )}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
            {editable && (
              <div className="border-t border-line p-5">
                <AddLineForm
                  documentId={quote.id}
                  currency={quote.currency}
                  taxRates={taxChoices}
                  intervals
                  services={services.data.map((s) => ({
                    id: s.id,
                    name: s.name,
                    hint: s.defaultPriceMinor !== null && s.currency === quote.currency ? ` · ${money(s.defaultPriceMinor, s.currency)}` : '',
                  }))}
                />
              </div>
            )}
          </Card>

          {editable ? (
            <Card>
              <CardHeader title="Details" />
              <div className="p-5">
                <QuoteDetailsForm
                  contacts={contacts.data.map((c) => ({ id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(' ') }))}
                  quote={{
                    id: quote.id,
                    title: quote.title,
                    contactId: quote.contactId,
                    currency: quote.currency,
                    taxMode: quote.taxMode,
                    validUntil: quote.validUntil,
                    discountPercent: quote.discountPercent,
                    discountAmount: quote.discountAmountMinor === null ? null : decimal(quote.discountAmountMinor),
                    notes: quote.notes,
                    terms: quote.terms,
                    hasLines: quote.lines.length > 0,
                  }}
                />
              </div>
            </Card>
          ) : (
            (quote.notes || quote.terms) && (
              <Card>
                <CardHeader title="Notes and terms" />
                <div className="space-y-4 p-5 text-sm">
                  {quote.notes && <p className="whitespace-pre-wrap">{quote.notes}</p>}
                  {quote.terms && <p className="whitespace-pre-wrap text-muted">{quote.terms}</p>}
                </div>
              </Card>
            )
          )}
        </div>

        <div className="space-y-6">
          <Totals quote={quote} />
          {(quote.split.recurring.length > 0 || options.data.length > 1) && (
            <Card>
              <CardHeader title="What it is for" />
              <dl className="space-y-2 p-5 text-sm">
                <div className="flex justify-between gap-4"><dt className="text-muted">One-time, before tax</dt><dd className="tabular-nums">{money(quote.split.oneTimeNetMinor, quote.currency)}</dd></div>
                {quote.split.recurring.map((r) => (
                  <div key={`${r.unit}${r.count}`} className="flex justify-between gap-4">
                    <dt className="text-muted">Every {r.count === 1 ? r.unit : `${r.count} ${r.unit}s`}</dt>
                    <dd className="tabular-nums">{money(r.perPeriodNetMinor, quote.currency)}</dd>
                  </div>
                ))}
              </dl>
              {options.data.length > 1 && (
                <div className="border-t border-line p-5 text-sm">
                  <p className="mb-2 font-medium">Offered as one of</p>
                  <ul className="space-y-1">
                    {options.data.map((o) => (
                      <li key={o.id} className="flex justify-between gap-2">
                        <Link href={`/quotes/${o.id}`} className={o.id === quote.id ? 'font-medium' : 'hover:underline'}>{o.optionLabel ?? o.title}</Link>
                        <QuoteStatusBadge status={o.status} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          )}
          {!draft && (
            <Card>
              <CardHeader title="The document" />
              <div className="p-5">
                <QuoteDocumentControls quoteId={quote.id} canEmail={can('quote:send')} suggestedEmail={null} />
              </div>
            </Card>
          )}
          {draft && can('quote:send') && (
            <Card>
              <CardHeader title="Send" description="Mark the quote as sent once it has gone to the client. It takes its number and can no longer change." />
              <div className="p-5"><SendQuoteForm quoteId={quote.id} currency={quote.currency} baseCurrency={settings.baseCurrency} /></div>
            </Card>
          )}
          {quote.status !== 'draft' && (can('invoice:create') || invoices.data.length > 0) && (
            <Card>
              <CardHeader title="Invoicing" description="A quote can be billed in as many invoices as the work needs." />
              <div className="space-y-4 p-5">
                {invoices.data.length > 0 && (
                  <ul className="space-y-1 text-sm">
                    {invoices.data.map((invoice) => (
                      <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-2">
                        <Link href={`/invoices/${invoice.id}`} className="hover:underline">{invoice.number ?? 'Draft'} · {invoice.title}</Link>
                        <span className="flex items-center gap-2">
                          <InvoiceStatusBadge status={invoice.status} />
                          <span className="tabular-nums">{money(invoice.totalMinor, invoice.currency)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {can('invoice:create') && quote.status === 'accepted' && invoices.data.length === 0 && quote.split.oneTimeNetMinor !== 0 && <InvoiceFromQuoteButton quoteId={quote.id} />}
              </div>
            </Card>
          )}
          {answering && (
            <Card>
              <CardHeader title="Accepted?" description="Accepting carries the quote into its project: the contract, any recurring billing, and a billing plan." />
              <div className="p-5">
                <AcceptQuoteForm
                  quoteId={quote.id}
                  currency={quote.currency}
                  projects={clientProjects.data.map((p) => ({ id: p.id, name: p.name }))}
                  quoteProject={quoteProject ? { id: quoteProject.id, name: quoteProject.name, contractSet: quoteProject.contractValueMinor !== null } : null}
                  oneTime={money(quote.split.oneTimeNetMinor, quote.currency)}
                  recurring={quote.split.recurring.map((r) => `${money(r.perPeriodNetMinor, quote.currency)} every ${r.count === 1 ? r.unit : `${r.count} ${r.unit}s`}`)}
                />
              </div>
            </Card>
          )}
          {answering && (
            <Card>
              <CardHeader title="Declined?" />
              <div className="p-5"><AnswerControls quoteId={quote.id} declineOnly /></div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusAlert({ quote, timezone }: { quote: Quote; timezone: string }) {
  const valid = `valid until ${formatDate(quote.validUntil)}`
  switch (quote.status) {
    case 'draft':
      return null
    case 'sent':
      return <Alert tone="info">Sent {formatDateTime(quote.sentAt, timezone)}, {valid}.</Alert>
    case 'accepted':
      return <Alert tone="success">Accepted {formatDateTime(quote.acceptedAt, timezone)}.</Alert>
    case 'declined':
      return <Alert tone="warning">Declined {formatDateTime(quote.declinedAt, timezone)}{quote.declineReason ? `: ${quote.declineReason}` : '.'}</Alert>
    case 'expired':
      return <Alert tone="warning">Expired unanswered; it was {valid}. Duplicate it to offer again.</Alert>
  }
}

function Totals({ quote }: { quote: Quote }) {
  const row = (label: string, minor: number, strong = false) => (
    <div className={`flex justify-between gap-4 ${strong ? 'border-t border-line pt-2 text-base font-semibold' : ''}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{money(minor, quote.currency)}</dd>
    </div>
  )
  const inclusive = quote.taxMode === 'inclusive'
  return (
    <Card>
      <CardHeader title="Totals" />
      <dl className="space-y-2 p-5 text-sm" aria-label="Quote totals">
        {row('Subtotal', quote.subtotalMinor)}
        {quote.discountMinor !== 0 && row(quote.discountPercent ? `Discount (${quote.discountPercent}%)` : 'Discount', -quote.discountMinor)}
        {!inclusive && quote.taxes.map((t) => <div key={t.taxRateId}>{row(`${t.name} ${t.rate}%`, t.taxMinor)}</div>)}
        {row('Total', quote.totalMinor, true)}
        {inclusive &&
          quote.taxes.map((t) => (
            <div key={t.taxRateId} className="flex justify-between gap-4 text-muted">
              <dt>Includes {t.name} {t.rate}%</dt>
              <dd className="tabular-nums">{money(t.taxMinor, quote.currency)}</dd>
            </div>
          ))}
        {quote.totalBaseMinor !== null && quote.baseCurrency !== quote.currency && (
          <div className="flex justify-between gap-4 text-muted">
            <dt>In {quote.baseCurrency} at {quote.exchangeRateToBase}</dt>
            <dd className="tabular-nums">{money(quote.totalBaseMinor, quote.baseCurrency!)}</dd>
          </div>
        )}
      </dl>
    </Card>
  )
}
