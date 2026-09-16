import { invoiceList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { InvoiceStatusBadge } from '@/components/finance/badges'
import { formatDate, todayIn } from '@/lib/format'
import { money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Invoices · Workloom' }

const VIEWS = {
  all: { label: 'All', filter: {} },
  draft: { label: 'Drafts', filter: { status: 'draft' as const } },
  outstanding: { label: 'Outstanding', filter: { outstanding: true } },
  paid: { label: 'Paid', filter: { status: 'paid' as const } },
  cancelled: { label: 'Cancelled', filter: { status: 'cancelled' as const } },
}

export default async function InvoicesPage({ searchParams }: PageProps<'/invoices'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const view = (param(query.view) ?? 'all') as keyof typeof VIEWS
  const { filter } = VIEWS[view] ?? VIEWS.all
  const q = param(query.q)
  const cursor = param(query.cursor)

  const [invoices, settings] = await Promise.all([
    call(invoiceList, { ...filter, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}), limit: 50 }),
    organizationSettings(),
  ])
  const today = todayIn(settings.timezone)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Invoices</h1>
        {viewer.permissions.has('invoice:create') && (
          <Link href="/invoices/new" className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900">
            New invoice
          </Link>
        )}
      </div>
      <Card>
        <CardHeader
          title={VIEWS[view]?.label ?? 'All'}
          action={
            <div className="flex flex-wrap items-center gap-3">
              <FilterTabs
                active={view}
                tabs={Object.entries(VIEWS).map(([key, v]) => ({ key, label: v.label, href: key === 'all' ? '/invoices' : `/invoices?view=${key}` }))}
              />
              <SearchBox action="/invoices" q={q} hidden={view === 'all' ? {} : { view }} placeholder="Title or number" />
            </div>
          }
        />
        {invoices.data.length === 0 ? (
          <EmptyState>No invoices{q || view !== 'all' ? ' match' : ' yet'}.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Client</Th>
                <Th>Status</Th>
                <Th className="text-right">Total</Th>
                <Th className="text-right">Due</Th>
                <Th>Due date</Th>
              </tr>
            </thead>
            <tbody>
              {invoices.data.map((invoice) => {
                const overdue = invoice.dueDate && invoice.dueDate < today && invoice.amountDueMinor > 0 && !['draft', 'cancelled', 'paid'].includes(invoice.status)
                return (
                  <tr key={invoice.id}>
                    <Td>
                      <Link href={`/invoices/${invoice.id}`} className="font-medium hover:underline">{invoice.title}</Link>
                      <div className="text-xs text-neutral-500">{invoice.number ?? 'Draft'}</div>
                    </Td>
                    <Td><Link href={`/companies/${invoice.companyId}?tab=invoices`} className="text-neutral-600 hover:underline">{invoice.companyName}</Link></Td>
                    <Td><InvoiceStatusBadge status={invoice.status} overdue={Boolean(overdue)} /></Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">{money(invoice.totalMinor, invoice.currency)}</Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">{invoice.amountDueMinor === 0 ? '—' : money(invoice.amountDueMinor, invoice.currency)}</Td>
                    <Td className={`whitespace-nowrap ${overdue ? 'font-medium text-red-600' : 'text-neutral-500'}`}>{formatDate(invoice.dueDate)}</Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
        <Pager base="/invoices" params={{ ...(view === 'all' ? {} : { view }), ...(q ? { q } : {}) }} cursor={cursor} nextCursor={invoices.nextCursor} />
      </Card>
    </div>
  )
}
