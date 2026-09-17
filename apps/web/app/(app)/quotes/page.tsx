import { quoteList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr, buttonStyles } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { QuoteStatusBadge } from '@/components/finance/badges'
import { formatDate } from '@/lib/format'
import { QUOTE_STATUS_LABELS } from '@/lib/finance-labels'
import { money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Quotes · Workloom' }

const STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const

export default async function QuotesPage({ searchParams }: PageProps<'/quotes'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const status = STATUSES.find((s) => s === param(query.status))
  const q = param(query.q)
  const cursor = param(query.cursor)
  const quotes = await call(quoteList, { ...(status ? { status } : {}), ...(q ? { q } : {}), ...(cursor ? { cursor } : {}), limit: 50 })
  const params: Record<string, string> = { ...(status ? { status } : {}), ...(q ? { q } : {}) }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quotes"
        actions={
          viewer.permissions.has('quote:create') && (
            <Link href="/quotes/new" className={buttonStyles()}>New quote</Link>
          )
        }
      />
      <Card>
        <CardHeader
          title={status ? QUOTE_STATUS_LABELS[status]! : 'All quotes'}
          action={
            <div className="flex flex-wrap items-center gap-3">
              <FilterTabs
                active={status ?? 'all'}
                tabs={[{ key: 'all', label: 'All', href: '/quotes' }, ...STATUSES.map((s) => ({ key: s, label: QUOTE_STATUS_LABELS[s]!, href: `/quotes?status=${s}` }))]}
              />
              <SearchBox action="/quotes" q={q} hidden={status ? { status } : {}} placeholder="Title or number" />
            </div>
          }
        />
        {quotes.data.length === 0 ? (
          <EmptyState>No quotes{status || q ? ' match' : ' yet'}.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Quote</Th><Th>Client</Th><Th>Status</Th><Th className="text-right">Total</Th><Th>Valid until</Th></tr></thead>
            <tbody>
              {quotes.data.map((quote) => (
                <Tr key={quote.id}>
                  <Td>
                    <Link href={`/quotes/${quote.id}`} className="font-medium hover:underline">{quote.title}</Link>
                    <div className="text-xs text-muted">{quote.number ?? 'Draft'}</div>
                  </Td>
                  <Td><Link href={`/companies/${quote.companyId}?tab=quotes`} className="text-muted hover:underline">{quote.companyName}</Link></Td>
                  <Td><QuoteStatusBadge status={quote.status} /></Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">{money(quote.totalMinor, quote.currency)}</Td>
                  <Td className="whitespace-nowrap text-muted">{formatDate(quote.validUntil)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager base="/quotes" params={params} cursor={cursor} nextCursor={quotes.nextCursor} />
      </Card>
    </div>
  )
}
