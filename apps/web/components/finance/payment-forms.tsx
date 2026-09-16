'use client'

import { Button } from '@workloom/ui'
import { useActionState } from 'react'
import {
  allocatePaymentAction,
  deletePaymentAction,
  recordPaymentAction,
  unallocatePaymentAction,
  updatePaymentAction,
} from '@/lib/actions/payments'
import { idle } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { PAYMENT_KIND_LABELS, PAYMENT_METHOD_LABELS } from '@/lib/finance-labels'
import { FormMessage, SubmitButton } from '../form-bits'
import { choices, SelectField, TextAreaField, TextField, type Choice } from '../crm/fields'

/**
 * Recording money. Every form here says what it is for and how much; what it
 * settles, and what that leaves the invoice reading as, is the procedure's
 * decision and the database's guarantee.
 */

export function RecordPaymentForm({
  companies,
  companyId,
  currency,
  baseCurrency,
  today,
  invoice,
  returnTo,
}: {
  companies?: Choice[]
  companyId: string | null
  currency: string
  baseCurrency: string
  today: string
  /** Set when recording against one invoice: the amount defaults to what it still owes. */
  invoice?: { id: string; number: string | null; amountDueMinor: string } | undefined
  returnTo?: string | undefined
}) {
  const [state, action] = useActionState(recordPaymentAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {invoice && <input type="hidden" name="invoiceId" value={invoice.id} />}
      {companyId && <input type="hidden" name="companyId" value={companyId} />}
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <input type="hidden" name="currency" value={currency} />
      <div className="grid gap-4 sm:grid-cols-2">
        {!companyId && companies && (
          <SelectField state={state} name="companyId" label="Client" empty="Choose a client" options={choices(companies)} />
        )}
        <SelectField
          state={state}
          id="payment-kind"
          name="kind"
          label="What happened"
          defaultValue="payment"
          options={options(PAYMENT_KIND_LABELS)}
          hint="A refund takes money back off the invoice it is put against."
        />
        <TextField
          state={state}
          id="payment-amount"
          name="amount"
          label={`Amount (${currency})`}
          required
          defaultValue={invoice?.amountDueMinor}
          placeholder="1250.00"
        />
        <TextField state={state} id="payment-receivedOn" name="receivedOn" label="Date" type="date" defaultValue={today} />
        <SelectField state={state} id="payment-method" name="method" label="How" defaultValue="bank_transfer" options={options(PAYMENT_METHOD_LABELS)} />
        <TextField state={state} id="payment-reference" name="reference" label="Reference" placeholder="Bank reference or receipt number" />
        {currency !== baseCurrency && (
          <TextField state={state} id="payment-exchangeRate" name="exchangeRate" label={`1 ${currency} in ${baseCurrency}`} placeholder="1.52" />
        )}
        {invoice && (
          <TextField
            state={state}
            id="payment-allocate"
            name="allocate"
            label={`Put against ${invoice.number ?? 'this invoice'}`}
            hint="Leave blank to use as much of it as the invoice still owes."
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Recording…">Record it</SubmitButton>
      </div>
    </form>
  )
}

/** Puts money already on account against one more invoice. */
export function AllocateForm({
  paymentId,
  currency,
  invoices,
}: {
  paymentId: string
  currency: string
  invoices: Array<{ id: string; label: string }>
}) {
  const [state, action] = useActionState(allocatePaymentAction, idle)
  if (invoices.length === 0) return <p className="text-sm text-neutral-500">Nothing outstanding to put this against.</p>
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="id" value={paymentId} />
      <input type="hidden" name="currency" value={currency} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          state={state}
          id="allocate-invoiceId"
          name="invoiceId"
          label="Invoice"
          empty="Choose an invoice"
          options={invoices.map((i) => ({ value: i.id, label: i.label }))}
        />
        <TextField state={state} id="allocate-amount" name="amount" label={`Amount (${currency})`} hint="Blank uses as much as fits." />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" variant="secondary" pendingLabel="Allocating…">Put against it</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function UnallocateButton({ allocationId, invoiceId, label }: { allocationId: string; invoiceId?: string; label: string }) {
  return (
    <form
      action={unallocatePaymentAction}
      onSubmit={(e) => {
        if (!confirm(`Take this off ${label}? The money stays on the client's account.`)) e.preventDefault()
      }}
    >
      <input type="hidden" name="id" value={allocationId} />
      {invoiceId && <input type="hidden" name="invoiceId" value={invoiceId} />}
      <Button type="submit" size="sm" variant="ghost">Take off</Button>
    </form>
  )
}

export function EditPaymentForm({
  payment,
}: {
  payment: { id: string; currency: string; amount: string; receivedOn: string; method: string; reference: string | null; notes: string | null }
}) {
  const [state, action] = useActionState(updatePaymentAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="id" value={payment.id} />
      <input type="hidden" name="currency" value={payment.currency} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="amount" label={`Amount (${payment.currency})`} defaultValue={payment.amount} hint="Cannot go below what it is already put against." />
        <TextField state={state} name="receivedOn" label="Date" type="date" defaultValue={payment.receivedOn} />
        <SelectField state={state} name="method" label="How" defaultValue={payment.method} options={options(PAYMENT_METHOD_LABELS)} />
        <TextField state={state} name="reference" label="Reference" defaultValue={payment.reference} />
      </div>
      <TextAreaField state={state} name="notes" label="Notes" defaultValue={payment.notes} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function DeletePaymentButton({ paymentId }: { paymentId: string }) {
  return (
    <form
      action={deletePaymentAction}
      onSubmit={(e) => {
        if (!confirm('Delete this payment? The invoices it settled go back to owing.')) e.preventDefault()
      }}
    >
      <input type="hidden" name="id" value={paymentId} />
      <Button type="submit" size="sm" variant="danger">Delete payment</Button>
    </form>
  )
}
