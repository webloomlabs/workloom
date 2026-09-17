import { expenseList } from '@workloom/core/modules'
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr, buttonStyles } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { formatDate } from '@/lib/format'
import { EXPENSE_CATEGORY_LABELS } from '@/lib/finance-labels'
import { money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Expenses · Workloom' }

const VIEWS = {
  all: { label: 'All', filter: {} },
  billable: { label: 'To rebill', filter: { billable: true, invoiced: false } },
  rebilled: { label: 'Rebilled', filter: { invoiced: true } },
}

export default async function ExpensesPage({ searchParams }: PageProps<'/expenses'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const view = (param(query.view) ?? 'all') as keyof typeof VIEWS
  const { filter } = VIEWS[view] ?? VIEWS.all
  const q = param(query.q)
  const cursor = param(query.cursor)
  const expenses = await call(expenseList, { ...filter, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}), limit: 50 })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        actions={
          viewer.permissions.has('expense:create') && (
            <Link href="/expenses/new" className={buttonStyles()}>
              Record an expense
            </Link>
          )
        }
      />
      <Card>
        <CardHeader
          title={VIEWS[view]?.label ?? 'All'}
          description="What the agency spent. Amounts are net of tax, which is what the work costs."
          action={
            <div className="flex flex-wrap items-center gap-3">
              <FilterTabs
                active={view}
                tabs={Object.entries(VIEWS).map(([key, v]) => ({ key, label: v.label, href: key === 'all' ? '/expenses' : `/expenses?view=${key}` }))}
              />
              <SearchBox action="/expenses" q={q} hidden={view === 'all' ? {} : { view }} placeholder="What or who from" />
            </div>
          }
        />
        {expenses.data.length === 0 ? (
          <EmptyState>No expenses{q || view !== 'all' ? ' match' : ' yet'}.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>What</Th>
                <Th>Category</Th>
                <Th>For</Th>
                <Th className="text-right">Cost</Th>
                <Th>Rebilling</Th>
              </tr>
            </thead>
            <tbody>
              {expenses.data.map((expense) => (
                <Tr key={expense.id}>
                  <Td className="whitespace-nowrap text-muted">{formatDate(expense.incurredOn)}</Td>
                  <Td>
                    <Link href={`/expenses/${expense.id}`} className="font-medium hover:underline">{expense.description}</Link>
                    {expense.supplier && <div className="text-xs text-muted">{expense.supplier}</div>}
                  </Td>
                  <Td className="text-muted">{EXPENSE_CATEGORY_LABELS[expense.category] ?? expense.category}</Td>
                  <Td className="text-muted">
                    {expense.projectId ? (
                      <Link href={`/projects/${expense.projectId}`} className="hover:underline">{expense.projectName}</Link>
                    ) : expense.companyId ? (
                      <Link href={`/companies/${expense.companyId}?tab=expenses`} className="hover:underline">{expense.companyName}</Link>
                    ) : (
                      <span className="text-faint">Overhead</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">{money(expense.amountMinor, expense.currency)}</Td>
                  <Td className="whitespace-nowrap">
                    {expense.invoiceId ? (
                      <Link href={`/invoices/${expense.invoiceId}`}><Badge tone="positive">{expense.invoiceNumber ?? 'Rebilled'}</Badge></Link>
                    ) : expense.billable ? (
                      <Badge tone="caution">To rebill{expense.markupPercent ? ` +${expense.markupPercent}%` : ''}</Badge>
                    ) : (
                      <span className="text-sm text-faint">Absorbed</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager base="/expenses" params={{ ...(view === 'all' ? {} : { view }), ...(q ? { q } : {}) }} cursor={cursor} nextCursor={expenses.nextCursor} />
      </Card>
    </div>
  )
}
