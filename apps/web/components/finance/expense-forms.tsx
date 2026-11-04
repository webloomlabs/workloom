'use client'

import { Button, Checkbox } from '@workloom/ui'
import { useActionState } from 'react'
import { billExpensesAction, confirmExpenseAction, createExpenseAction, deleteExpenseAction, deleteReceiptAction, startFromReceiptAction, updateExpenseAction, uploadReceiptsAction } from '@/lib/actions/expenses'
import { idle } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { EXPENSE_PAYMENT_METHOD_LABELS } from '@/lib/finance-labels'
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
  bankAccountId: string | null
  notes: string | null
  paymentMethod: string | null
  paidOn: string | null
  reimbursable: boolean
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
  accounts,
  defaultAccountId,
  categories,
}: {
  expense: ExpenseValues
  companies: Choice[]
  projects: Choice[]
  /** The organization's active expense categories, by key. */
  categories: Choice[]
  taxRates: TaxChoice[]
  baseCurrency: string
  returnTo?: string | undefined
  /** Open accounts in this expense's currency. Empty when none has been set up. */
  accounts?: Choice[]
  defaultAccountId?: string | null | undefined
}) {
  const editing = Boolean(expense.id)
  const [state, action] = useActionState(editing ? updateExpenseAction : createExpenseAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      {expense.id && <input type="hidden" name="id" value={expense.id} />}
      {editing && <input type="hidden" name="currency" value={expense.currency} />}
      <input type="hidden" name="baseCurrency" value={baseCurrency} />
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="description" label="What was it" required defaultValue={expense.description} placeholder="Annual hosting" />
        <TextField state={state} name="supplier" label="Supplier" defaultValue={expense.supplier} placeholder="Vultr" />
        <TextField state={state} name="amount" label={editing ? `Amount, before tax (${expense.currency})` : `Amount (${expense.currency})`} required defaultValue={expense.amount} placeholder="120.00" />
        {!editing && (
          <SelectField
            state={state}
            name="amountMode"
            label="That amount is"
            defaultValue="gross"
            options={[
              { value: 'gross', label: 'The total on the receipt, tax included' },
              { value: 'net', label: 'Before tax' },
            ]}
          />
        )}
        <SelectField state={state} name="taxRateId" label="Tax" empty="No tax" defaultValue={expense.taxRateId} options={taxRates.map((t) => ({ value: t.id, label: `${t.name} (${t.rate}%)` }))} />
        <TextField state={state} name="incurredOn" label="Date" type="date" defaultValue={expense.incurredOn} />
        <SelectField state={state} name="category" label="Category" defaultValue={expense.category} options={choices(categories)} />
        <SelectField state={state} name="paymentMethod" label="Paid by" empty="Not recorded" defaultValue={expense.paymentMethod} options={options(EXPENSE_PAYMENT_METHOD_LABELS)} />
        <TextField state={state} name="paidOn" label="Paid on" type="date" defaultValue={expense.paidOn} hint="If not the day it was incurred." />
        <SelectField state={state} name="projectId" label="Project" empty="Not a project cost" defaultValue={expense.projectId} options={choices(projects)} hint="Its client comes from the project." />
        <SelectField state={state} name="companyId" label="Client" empty="The agency's own cost" defaultValue={expense.companyId} options={choices(companies)} />
        {expense.currency !== baseCurrency && (
          <TextField state={state} name="exchangeRate" label={`1 ${expense.currency} in ${baseCurrency}`} placeholder="1.52" />
        )}
        {!editing && <TextField state={state} name="currency" label="Currency" defaultValue={expense.currency} />}
        {accounts && accounts.length > 0 && (
          <SelectField
            state={state}
            name="bankAccountId"
            label="Paid from"
            empty="Not recorded"
            defaultValue={editing ? expense.bankAccountId : (expense.bankAccountId ?? defaultAccountId ?? '')}
            options={choices(accounts)}
            hint="It does not add a line to the register — the bank statement still does that."
          />
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="billable" defaultChecked={expense.billable} /> Rebill this to the client
        </label>
        <TextField state={state} name="markupPercent" label="Markup (%)" defaultValue={expense.markupPercent} hint="Added when it is rebilled. Blank charges it at cost." />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="reimbursable" defaultChecked={expense.reimbursable} /> Someone paid this themselves and is owed it back
        </label>
      </div>
      {!editing && (
        <div className="space-y-1">
          <label htmlFor="receipts" className="text-sm font-medium">Receipts</label>
          <input id="receipts" name="receipts" type="file" multiple accept="image/*,application/pdf,.heic" className="block text-sm" />
          <p className="text-xs text-muted">Photos or PDFs, up to 10 MB each.</p>
        </div>
      )}
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

/** Confirms a draft: it takes its number and starts to count. */
export function ConfirmExpenseButton({ expenseId }: { expenseId: string }) {
  const [state, action] = useActionState(confirmExpenseAction, idle)
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={expenseId} />
      <SubmitButton pendingLabel="Confirming…">Confirm expense</SubmitButton>
      <FormMessage state={state} />
    </form>
  )
}

/** Adds receipts to an expense that already exists. */
export function UploadReceiptsForm({ expenseId }: { expenseId: string }) {
  const [state, action] = useActionState(uploadReceiptsAction, idle)
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={expenseId} />
      <input name="receipts" type="file" multiple accept="image/*,application/pdf,.heic" aria-label="Receipt files" className="block text-sm" required />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" variant="secondary" pendingLabel="Uploading…">Attach</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function DeleteReceiptButton({ receiptId, expenseId, filename }: { receiptId: string; expenseId: string; filename: string }) {
  return (
    <form
      action={deleteReceiptAction}
      onSubmit={(e) => {
        if (!confirm(`Remove ${filename}?`)) e.preventDefault()
      }}
    >
      <input type="hidden" name="id" value={receiptId} />
      <input type="hidden" name="expenseId" value={expenseId} />
      <Button type="submit" size="xs" variant="ghost" aria-label={`Remove ${filename}`}>Remove</Button>
    </form>
  )
}

/** Drop a receipt, get a draft: read by AI first when the organization has turned that on. */
export function StartFromReceiptForm({ reading }: { reading: boolean }) {
  const [state, action] = useActionState(startFromReceiptAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <div className="space-y-1">
        <label htmlFor="start-receipt" className="text-sm font-medium">Receipt</label>
        <input id="start-receipt" name="receipt" type="file" accept="image/*,application/pdf,.heic" className="block text-sm" required />
        <p className="text-xs text-muted">
          {reading ? 'A photo or PDF, up to 10 MB. AI reads it and fills in the draft for you to check.' : 'A photo or PDF, up to 10 MB. It is saved as a draft for you to fill in.'}
        </p>
      </div>
      <TextField state={state} id="start-note" name="note" label="Note (optional)" placeholder="Taxi to the Kyla & Co. meeting" />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="secondary" pendingLabel={reading ? 'Reading the receipt…' : 'Saving…'}>Start a draft from it</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
