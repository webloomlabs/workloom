import { minorToDecimalString, type Permission } from '@workloom/core'
import { companyList, expenseCategoryList, expenseGet, expenseReceiptList, organizationGet, projectList, taxRateList } from '@workloom/core/modules'
import { Alert, Badge, Card, CardHeader, EmptyState, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ConfirmExpenseButton, DeleteExpenseButton, DeleteReceiptButton, ExpenseForm, UploadReceiptsForm } from '@/components/finance/expense-forms'
import { formatDate } from '@/lib/format'
import { EXPENSE_PAYMENT_METHOD_LABELS } from '@/lib/finance-labels'
import { accountChoices, money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Expense · Workloom' }

/** What reading the receipt gave, said plainly: a person checks it before confirming. */
function readFrom(expense: { currency: string; extraction: Record<string, unknown> | null }): string | null {
  const read = expense.extraction
  if (!read || typeof read.reader !== 'string') return null
  const currency = typeof read.currency === 'string' ? read.currency : null
  const amount = typeof read.amountMinor === 'number' ? read.amountMinor : null
  if (currency && currency !== expense.currency && amount !== null) {
    return ` The receipt was read as ${currency} ${minorToDecimalString(amount, currency)}: enter the currency and its exchange rate before confirming.`
  }
  return ' Filled in from the receipt by AI — check the amount, date, and category before confirming.'
}

export default async function ExpensePage({ params, searchParams }: PageProps<'/expenses/[id]'>) {
  const { id } = await params
  const { refused } = await searchParams
  const viewer = await requireViewer()
  const can = (p: Permission) => viewer.permissions.has(p)
  const expense = await call(expenseGet, { id })
  const rebilled = expense.invoiceLineId !== null
  const accounts = await accountChoices(expense.currency, can('bankAccount:read'))
  const mine = viewer.actor.type === 'user' && expense.createdBy === viewer.actor.id
  // Your own expense is yours to correct and evidence; someone else's needs expense:update.
  const editable = (can('expense:update') || (mine && can('expense:create'))) && !rebilled
  const canConfirm = expense.status === 'draft' && (can('expense:update') || (mine && can('expense:create')))
  const [receipts, categories] = await Promise.all([call(expenseReceiptList, { expenseId: expense.id }), call(expenseCategoryList, { includeArchived: true })])

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
            {expense.status === 'draft' ? <Badge tone="caution">Draft</Badge> : expense.number && <span className="font-medium text-ink">{expense.number}</span>}
            <span>{formatDate(expense.incurredOn)}</span>
            <span>{expense.categoryName}</span>
            {expense.paymentMethod && <span>{EXPENSE_PAYMENT_METHOD_LABELS[expense.paymentMethod]}</span>}
            {expense.reimbursable && <Badge tone="info">To reimburse</Badge>}
            {expense.supplier && <span>{expense.supplier}</span>}
            {expense.bankAccountId && (
              <Link href={`/banking/${expense.bankAccountId}`} className="hover:underline">
                from {expense.bankAccountName}
              </Link>
            )}
            {expense.projectId && <Link href={`/projects/${expense.projectId}`} className="hover:underline">{expense.projectName}</Link>}
            {expense.companyId && <Link href={`/companies/${expense.companyId}?tab=expenses`} className="hover:underline">{expense.companyName}</Link>}
          </div>
        }
        actions={
          !rebilled && (can('expense:delete') || (mine && expense.status === 'draft')) && <DeleteExpenseButton expenseId={expense.id} />
        }
      />

      {typeof refused === 'string' && <Alert tone="warning">Recorded, but these files were not accepted as receipts: {refused}. A receipt must be a photo or a PDF, up to 10 MB.</Alert>}

      {expense.status === 'draft' && (
        <Alert tone="info">
          This is a draft{expense.source === 'telegram' ? ', read from a receipt sent on Telegram' : ''}. It does not count as a cost until it is confirmed.
          {readFrom(expense)}
        </Alert>
      )}

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
                categories={categories.data.filter((c) => !c.archived || c.key === expense.category).map((c) => ({ id: c.key, name: c.name }))}
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
                  bankAccountId: expense.bankAccountId,
                  notes: expense.notes,
                  paymentMethod: expense.paymentMethod,
                  paidOn: expense.paidOn,
                  reimbursable: expense.reimbursable,
                }}
                accounts={accounts.choices}
              />
            </div>
          </Card>
        ) : (
          <Card>
            <CardHeader title="Notes" />
            <div className="p-5 text-sm">{expense.notes ? <p className="whitespace-pre-wrap">{expense.notes}</p> : <p className="text-muted">None.</p>}</div>
          </Card>
        )}

        <div className="space-y-6">
        {canConfirm && (
          <Card>
            <CardHeader title="Confirm" description="Check it against the receipt. Confirming gives it its number and counts it as a cost." />
            <div className="p-5"><ConfirmExpenseButton expenseId={expense.id} /></div>
          </Card>
        )}
        <Card>
          <CardHeader title="Receipts" description={receipts.data.length === 0 ? 'None attached yet.' : undefined} />
          {receipts.data.length === 0 ? (
            <EmptyState>An auditor will ask for this. Attach a photo or PDF.</EmptyState>
          ) : (
            <ul className="space-y-3 p-5">
              {receipts.data.map((r) => (
                <li key={r.id} className="space-y-2">
                  {r.previewable && (
                    <a href={`/files/expense-receipts/${r.id}`} target="_blank" rel="noreferrer">
                      <img src={`/files/expense-receipts/${r.id}`} alt={`Receipt ${r.filename}`} className="max-h-64 w-full rounded-md border border-line object-contain" />
                    </a>
                  )}
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <a href={`/files/expense-receipts/${r.id}`} className="truncate hover:underline">{r.filename}</a>
                    {editable && <DeleteReceiptButton receiptId={r.id} expenseId={expense.id} filename={r.filename} />}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {editable && <div className="border-t border-line p-5"><UploadReceiptsForm expenseId={expense.id} /></div>}
        </Card>
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
