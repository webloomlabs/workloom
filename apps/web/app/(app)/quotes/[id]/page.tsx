import { minorToDecimalString, type Permission } from '@workloom/core'
import { contactList, quoteGet, serviceList, taxRateList, type Quote } from '@workloom/core/modules'
import { Alert, Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { QuoteStatusBadge } from '@/components/finance/badges'
import {
  AddLineForm,
  AnswerControls,
  DeleteDraftButton,
  DuplicateQuoteButton,
  LineControls,
  QuoteDetailsForm,
  SendQuoteForm,
} from '@/components/finance/finance-forms'
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
  const [quote, settings] = await Promise.all([call(quoteGet, { id }), organizationSettings()])
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
  const decimal = (minor: number) => minorToDecimalString(minor, quote.currency)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link href="/quotes" className="text-sm text-neutral-500 hover:underline">← Quotes</Link>
          <h1 className="text-xl font-semibold tracking-tight">{quote.title}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500">
            <QuoteStatusBadge status={quote.status} />
            {quote.number && <span className="font-medium text-neutral-800 dark:text-neutral-200">{quote.number}</span>}
            <Link href={`/companies/${quote.companyId}?tab=quotes`} className="hover:underline">{quote.companyName}</Link>
            {quote.contactName && <span>{quote.contactName}</span>}
            {quote.dealId && <Link href={`/deals/${quote.dealId}`} className="hover:underline">View deal</Link>}
            <span>{TAX_MODE_LABELS[quote.taxMode]}</span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          {can('quote:create') && <DuplicateQuoteButton quoteId={quote.id} />}
          {draft && can('quote:delete') && <DeleteDraftButton quoteId={quote.id} />}
        </div>
      </div>

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
                    <tr key={line.id}>
                      <Td>{line.description}</Td>
                      <Td className="text-right tabular-nums">{line.quantity}</Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">{money(line.unitAmountMinor, quote.currency)}</Td>
                      <Td className="text-right tabular-nums text-neutral-600">{line.discountPercent ? `${line.discountPercent}%` : ''}</Td>
                      <Td className="whitespace-nowrap text-neutral-600">{line.taxName ? `${line.taxName} ${line.taxRate}%` : 'No tax'}</Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">{money(line.netMinor, quote.currency)}</Td>
                      {editable && (
                        <Td>
                          <LineControls
                            quoteId={quote.id}
                            currency={quote.currency}
                            taxRates={taxChoices}
                            line={{ id: line.id, description: line.description, quantity: line.quantity, unitAmount: decimal(line.unitAmountMinor), discountPercent: line.discountPercent, taxRateId: line.taxRateId }}
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
                  quoteId={quote.id}
                  currency={quote.currency}
                  taxRates={taxChoices}
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
                  {quote.terms && <p className="whitespace-pre-wrap text-neutral-600">{quote.terms}</p>}
                </div>
              </Card>
            )
          )}
        </div>

        <div className="space-y-6">
          <Totals quote={quote} />
          {draft && can('quote:send') && (
            <Card>
              <CardHeader title="Send" description="Mark the quote as sent once it has gone to the client. It takes its number and can no longer change." />
              <div className="p-5"><SendQuoteForm quoteId={quote.id} currency={quote.currency} baseCurrency={settings.baseCurrency} /></div>
            </Card>
          )}
          {quote.status === 'sent' && can('quote:update') && (
            <Card>
              <CardHeader title="The client's answer" />
              <div className="p-5"><AnswerControls quoteId={quote.id} /></div>
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
    <div className={`flex justify-between gap-4 ${strong ? 'border-t border-neutral-200 pt-2 text-base font-semibold dark:border-neutral-800' : ''}`}>
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
            <div key={t.taxRateId} className="flex justify-between gap-4 text-neutral-500">
              <dt>Includes {t.name} {t.rate}%</dt>
              <dd className="tabular-nums">{money(t.taxMinor, quote.currency)}</dd>
            </div>
          ))}
        {quote.totalBaseMinor !== null && quote.baseCurrency !== quote.currency && (
          <div className="flex justify-between gap-4 text-neutral-500">
            <dt>In {quote.baseCurrency} at {quote.exchangeRateToBase}</dt>
            <dd className="tabular-nums">{money(quote.totalBaseMinor, quote.baseCurrency!)}</dd>
          </div>
        )}
      </dl>
    </Card>
  )
}
