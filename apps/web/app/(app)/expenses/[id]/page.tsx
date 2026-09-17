import { minorToDecimalString, type Permission } from '@workloom/core'
import { companyList, expenseGet, organizationGet, projectList, taxRateList } from '@workloom/core/modules'
import { Alert, Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DeleteExpenseButton, ExpenseForm } from '@/components/finance/expense-forms'
import { formatDate } from '@/lib/format'
import { EXPENSE_CATEGORY_LABELS } from '@/lib/finance-labels'
import { money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Expense · Workloom' }

export default async function ExpensePage({ params }: PageProps<'/expenses/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (p: Permission) => viewer.permissions.has(p)
  const expense = await call(expenseGet, { id })
  const rebilled = expense.invoiceLineId !== null
  const editable = can('expense:update') && !rebilled

  const [companies, projects, taxRates, organization] = editable
    ? await Promise.all([
        call(companyList, { limit: 100 }),
        can('project:read') ? call(projectList, { limit: 100 }) : { data: [] },
        can('taxRate:read') ? call(taxRateList, {}) : { data: [] },
        call(organizationGet, {}),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, await call(organizationGet, {})]

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/expenses" className="text-sm text-muted hover:underline">← Expenses</Link>}
        title={expense.description}
        description={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{formatDate(expense.incurredOn)}</span>
            <span>{EXPENSE_CATEGORY_LABELS[expense.category] ?? expense.category}</span>
            {expense.supplier && <span>{expense.supplier}</span>}
            {expense.projectId && <Link href={`/projects/${expense.projectId}`} className="hover:underline">{expense.projectName}</Link>}
            {expense.companyId && <Link href={`/companies/${expense.companyId}?tab=expenses`} className="hover:underline">{expense.companyName}</Link>}
          </div>
        }
        actions={
          editable && can('expense:delete') && <DeleteExpenseButton expenseId={expense.id} />
        }
      />

      {rebilled && (
        <Alert tone="info">
          Rebilled to the client on{' '}
          <Link href={`/invoices/${expense.invoiceId}`} className="underline">{expense.invoiceNumber ?? 'a draft invoice'}</Link>, so it can no longer
          change. Remove it from that invoice to free it.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr] [&>*]:min-w-0">
        {editable ? (
          <Card>
            <CardHeader title="Details" />
            <div className="p-5">
              <ExpenseForm
                companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
                projects={projects.data.map((p) => ({ id: p.id, name: p.name }))}
                taxRates={taxRates.data.map((t) => ({ id: t.id, name: t.name, rate: t.rate }))}
                baseCurrency={organization.baseCurrency}
                expense={{
                  id: expense.id,
                  description: expense.description,
                  supplier: expense.supplier,
                  category: expense.category,
                  incurredOn: expense.incurredOn,
                  projectId: expense.projectId,
                  companyId: expense.companyId,
                  currency: expense.currency,
                  amount: minorToDecimalString(expense.amountMinor, expense.currency),
                  taxRateId: expense.taxRateId,
                  billable: expense.billable,
                  markupPercent: expense.markupPercent,
                  notes: expense.notes,
                }}
              />
            </div>
          </Card>
        ) : (
          <Card>
            <CardHeader title="Notes" />
            <div className="p-5 text-sm">{expense.notes ? <p className="whitespace-pre-wrap">{expense.notes}</p> : <p className="text-muted">None.</p>}</div>
          </Card>
        )}

        <Card>
          <CardHeader title="Cost" />
          <dl className="space-y-2 p-5 text-sm" aria-label="Expense cost">
            <Row label="Net" value={money(expense.amountMinor, expense.currency)} />
            {expense.taxName && <Row label={`${expense.taxName} ${expense.taxRate}%`} value={money(expense.taxMinor, expense.currency)} />}
            <div className="flex justify-between gap-4 border-t border-line pt-2 font-semibold">
              <dt>Paid out</dt>
              <dd className="tabular-nums">{money(expense.totalMinor, expense.currency)}</dd>
            </div>
            {expense.billable && <Row label={expense.markupPercent ? `Rebills at cost +${expense.markupPercent}%` : 'Rebills at cost'} value={money(expense.rebillMinor, expense.currency)} />}
            {expense.baseCurrency !== expense.currency && (
              <Row label={`In ${expense.baseCurrency} at ${expense.exchangeRateToBase}`} value={money(expense.amountBaseMinor, expense.baseCurrency)} />
            )}
          </dl>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
