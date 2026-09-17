'use client'

import { Button, Checkbox, Field, Select } from '@workloom/ui'
import { useActionState, useState } from 'react'
import {
  billTimeAction,
  cancelInvoiceAction,
  createInvoiceAction,
  deleteInvoiceAction,
  emailInvoiceAction,
  invoiceFromQuoteAction,
  sendInvoiceAction,
} from '@/lib/actions/invoices'
import { idle } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { TAX_MODE_LABELS } from '@/lib/finance-labels'
import { FormMessage, SubmitButton } from '../form-bits'
import { choices, SelectField, TextField, type Choice } from '../crm/fields'
import type { TaxChoice } from './finance-forms'

export function CreateInvoiceForm({
  companies,
  companyId,
  currency,
  paymentTermsDays,
}: {
  companies: Choice[]
  companyId: string | null
  currency: string
  paymentTermsDays: number
}) {
  const [state, action] = useActionState(createInvoiceAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="title" label="Title" required placeholder="Website rebuild" />
        <SelectField state={state} name="companyId" label="Client" defaultValue={companyId} empty="Choose a client" options={choices(companies)} />
        <TextField state={state} name="currency" label="Currency" defaultValue={currency} />
        <SelectField state={state} name="taxMode" label="Tax" defaultValue="exclusive" options={options(TAX_MODE_LABELS)} />
        <TextField state={state} name="paymentTermsDays" label="Payment terms (days)" defaultValue={String(paymentTermsDays)} hint="The due date is this many days after issuing." />
      </div>
      <SubmitButton pendingLabel="Creating…">Create draft</SubmitButton>
    </form>
  )
}

/** Raises a draft invoice from a quote, on the quote's own page. */
export function InvoiceFromQuoteButton({ quoteId }: { quoteId: string }) {
  const [state, action] = useActionState(invoiceFromQuoteAction, idle)
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={quoteId} />
      <SubmitButton size="sm" variant="secondary" pendingLabel="Raising…">Create invoice</SubmitButton>
      <FormMessage state={state} />
    </form>
  )
}

export function SendInvoiceForm({
  invoiceId,
  currency,
  baseCurrency,
  suggestedEmail,
}: {
  invoiceId: string
  currency: string
  baseCurrency: string
  suggestedEmail: string | null
}) {
  const [state, action] = useActionState(sendInvoiceAction, idle)
  const [email, setEmail] = useState(Boolean(suggestedEmail))
  return (
    <form
      action={action}
      className="space-y-3"
      onSubmit={(e) => {
        if (!confirm('Issue this invoice? It takes its number now and can no longer be edited.')) e.preventDefault()
      }}
      noValidate
    >
      <input type="hidden" name="id" value={invoiceId} />
      {currency !== baseCurrency && (
        <TextField state={state} name="exchangeRate" label={`1 ${currency} in ${baseCurrency}`} hint="Fixed on the invoice when it is issued." placeholder="1.52" />
      )}
      <label className="flex items-center gap-2 text-sm">
        <Checkbox name="email" checked={email} onChange={(e) => setEmail(e.currentTarget.checked)} /> Email it to the client
      </label>
      {email && <TextField state={state} name="to" label="To" defaultValue={suggestedEmail} placeholder="accounts@client.example" />}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Issuing…">Issue invoice</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function EmailInvoiceForm({ invoiceId, suggestedEmail }: { invoiceId: string; suggestedEmail: string | null }) {
  const [state, action] = useActionState(emailInvoiceAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="id" value={invoiceId} />
      <TextField state={state} id="email-to" name="to" label="Send to" defaultValue={suggestedEmail} placeholder="accounts@client.example" />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" variant="secondary" pendingLabel="Sending…">Send the invoice</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function BillTimeForm({ invoiceId, projects, taxRates }: { invoiceId: string; projects: Choice[]; taxRates: TaxChoice[] }) {
  const [state, action] = useActionState(billTimeAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="id" value={invoiceId} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField state={state} id="bill-projectId" name="projectId" label="Project" empty="All this client's projects" options={choices(projects)} />
        <SelectField
          state={state}
          id="bill-groupBy"
          name="groupBy"
          label="One line per"
          defaultValue="task"
          options={[
            { value: 'task', label: 'Task' },
            { value: 'person', label: 'Person' },
            { value: 'entry', label: 'Entry' },
          ]}
        />
        <TextField state={state} id="bill-from" name="from" label="From" type="date" />
        <TextField state={state} id="bill-to" name="to" label="To" type="date" />
        <SelectField
          state={state}
          id="bill-taxRateId"
          name="taxRateId"
          label="Tax"
          empty="No tax"
          options={taxRates.map((t) => ({ value: t.id, label: `${t.name} (${t.rate}%)` }))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" variant="secondary" pendingLabel="Adding…">Add unbilled time</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function CancelInvoiceControls({ invoiceId }: { invoiceId: string }) {
  const [state, action] = useActionState(cancelInvoiceAction, idle)
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-2">
      <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Keep it' : 'Cancel invoice…'}
      </Button>
      {open && (
        <form action={action} className="space-y-2">
          <input type="hidden" name="id" value={invoiceId} />
          <TextField state={state} id="cancel-reason" name="reason" label="Why? (optional)" />
          <SubmitButton size="sm" variant="danger" pendingLabel="Cancelling…">Cancel this invoice</SubmitButton>
        </form>
      )}
      <FormMessage state={state} />
    </div>
  )
}

export function DeleteInvoiceButton({ invoiceId }: { invoiceId: string }) {
  return (
    <form
      action={deleteInvoiceAction}
      onSubmit={(e) => {
        if (!confirm('Delete this draft invoice? Any time it billed becomes billable again.')) e.preventDefault()
      }}
    >
      <input type="hidden" name="id" value={invoiceId} />
      <Button type="submit" size="sm" variant="ghost">Delete draft</Button>
    </form>
  )
}

/** Copies the client's link, so it can be pasted into a message. */
export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Field id="public-link" label="The client's link">
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="public-link"
          readOnly
          value={url}
          className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-raised px-2 text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(url)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </Field>
  )
}

/** The status select on the invoices list, kept as a plain form so it works without JavaScript. */
export function StatusFilter({ value, statuses }: { value: string; statuses: Array<{ value: string; label: string }> }) {
  return (
    <form action="/invoices" className="flex items-center gap-2">
      <label htmlFor="status" className="sr-only">Status</label>
      <Select id="status" name="status" defaultValue={value} className="h-8 text-xs">
        <option value="">Every status</option>
        {statuses.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </Select>
      <Button type="submit" size="sm" variant="secondary">Show</Button>
    </form>
  )
}
