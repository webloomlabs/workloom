'use client'

import { Button } from '@workloom/ui'
import { useActionState } from 'react'
import { billExpensesAction, createExpenseAction, deleteExpenseAction, updateExpenseAction } from '@/lib/actions/expenses'
import { idle } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { EXPENSE_CATEGORY_LABELS } from '@/lib/finance-labels'
import { FormMessage, SubmitButton } from '../form-bits'
import { choices, SelectField, TextAreaField, TextField, type Choice } from '../crm/fields'
import type { TaxChoice } from './finance-forms'

export type ExpenseValues = {
  id?: string
  description: string
  supplier: string | null
  category: string
  incurredOn: string
  projectId: string | null
  companyId: string | null
  currency: string
  amount: string
  taxRateId: string | null
  billable: boolean
  markupPercent: string | null
  notes: string | null
}

/**
 * One form for recording an expense and for correcting one. The amount is what
 * it cost net of tax, because that is what the work cost; the tax is charged on
 * top and, where it is reclaimed, never reaches a project's margin.
 */
export function ExpenseForm({
  expense,
  companies,
  projects,
  taxRates,
  baseCurrency,
  returnTo,
}: {
  expense: ExpenseValues
  companies: Choice[]
  projects: Choice[]
  taxRates: TaxChoice[]
  baseCurrency: string
  returnTo?: string | undefined
}) {
  const editing = Boolean(expense.id)
  const [state, action] = useActionState(editing ? updateExpenseAction : createExpenseAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      {expense.id && <input type="hidden" name="id" value={expense.id} />}
      {editing && <input type="hidden" name="currency" value={expense.currency} />}
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="description" label="What was it" required defaultValue={expense.description} placeholder="Annual hosting" />
        <TextField state={state} name="supplier" label="Supplier" defaultValue={expense.supplier} placeholder="Vultr" />
        <TextField state={state} name="amount" label={`Amount, before tax (${expense.currency})`} required defaultValue={expense.amount} placeholder="120.00" />
        <SelectField state={state} name="taxRateId" label="Tax" empty="No tax" defaultValue={expense.taxRateId} options={taxRates.map((t) => ({ value: t.id, label: `${t.name} (${t.rate}%)` }))} />
        <TextField state={state} name="incurredOn" label="Date" type="date" defaultValue={expense.incurredOn} />
        <SelectField state={state} name="category" label="Category" defaultValue={expense.category} options={options(EXPENSE_CATEGORY_LABELS)} />
        <SelectField state={state} name="projectId" label="Project" empty="Not a project cost" defaultValue={expense.projectId} options={choices(projects)} hint="Its client comes from the project." />
        <SelectField state={state} name="companyId" label="Client" empty="The agency's own cost" defaultValue={expense.companyId} options={choices(companies)} />
        {expense.currency !== baseCurrency && (
          <TextField state={state} name="exchangeRate" label={`1 ${expense.currency} in ${baseCurrency}`} placeholder="1.52" />
        )}
        {!editing && <TextField state={state} name="currency" label="Currency" defaultValue={expense.currency} />}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="billable" defaultChecked={expense.billable} /> Rebill this to the client
        </label>
        <TextField state={state} name="markupPercent" label="Markup (%)" defaultValue={expense.markupPercent} hint="Added when it is rebilled. Blank charges it at cost." />
      </div>
      <TextAreaField state={state} name="notes" label="Notes" defaultValue={expense.notes} />
      <SubmitButton pendingLabel="Saving…">{editing ? 'Save changes' : 'Record expense'}</SubmitButton>
    </form>
  )
}

export function DeleteExpenseButton({ expenseId }: { expenseId: string }) {
  return (
    <form
      action={deleteExpenseAction}
      onSubmit={(e) => {
        if (!confirm('Delete this expense?')) e.preventDefault()
      }}
    >
      <input type="hidden" name="id" value={expenseId} />
      <Button type="submit" size="sm" variant="danger">Delete expense</Button>
    </form>
  )
}

/** Adds the client's unbilled billable expenses to a draft invoice. */
export function BillExpensesForm({ invoiceId, projects, taxRates }: { invoiceId: string; projects: Choice[]; taxRates: TaxChoice[] }) {
  const [state, action] = useActionState(billExpensesAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="id" value={invoiceId} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField state={state} id="rebill-projectId" name="projectId" label="Project" empty="All this client's projects" options={choices(projects)} />
        <TextField state={state} id="rebill-from" name="from" label="Incurred from" type="date" />
        <TextField state={state} id="rebill-to" name="to" label="Incurred to" type="date" />
        <SelectField
          state={state}
          id="rebill-taxRateId"
          name="taxRateId"
          label="Tax"
          // "" is no tax at all; "default" leaves each line the tax its expense carried.
          empty="No tax"
          defaultValue="default"
          options={[
            { value: 'default', label: 'Whatever each expense carried' },
            ...taxRates.map((t) => ({ value: t.id, label: `${t.name} (${t.rate}%)` })),
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" variant="secondary" pendingLabel="Adding…">Add unbilled expenses</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
