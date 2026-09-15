'use client'

import { Button, Field, Input, Select } from '@workloom/ui'
import { useActionState, useState } from 'react'
import {
  addQuoteLineAction,
  answerQuoteAction,
  createQuoteAction,
  createServiceAction,
  createTaxRateAction,
  deleteQuoteAction,
  duplicateQuoteAction,
  removeQuoteLineAction,
  sendQuoteAction,
  setServiceArchivedAction,
  setTaxRateArchivedAction,
  updateQuoteAction,
  updateQuoteLineAction,
  updateServiceAction,
  updateTaxRateAction,
} from '@/lib/actions/finance'
import { idle, type ActionState } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { BILLING_TYPE_LABELS, PRICING_MODEL_LABELS, TAX_MODE_LABELS } from '@/lib/finance-labels'
import { FormMessage, SubmitButton, fieldError } from '../form-bits'
import { choices, initial, SelectField, TextAreaField, TextField, type Choice } from '../crm/fields'

export type TaxChoice = { id: string; name: string; rate: string }

const taxLabel = (t: TaxChoice) => `${t.name} (${t.rate}%)`

// Tax rates

export function CreateTaxRateForm() {
  const [state, action] = useActionState(createTaxRateAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_3fr]">
        <TextField state={state} id="new-tax-name" name="name" label="Name" placeholder="GST" />
        <TextField state={state} id="new-tax-rate" name="rate" label="Rate (%)" placeholder="10" />
        <TextField state={state} id="new-tax-description" name="description" label="Description" placeholder="Optional" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Adding…">Add tax rate</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function TaxRateControls({ taxRate, canEdit, canArchive }: { taxRate: TaxChoice & { description: string | null; archived: boolean }; canEdit: boolean; canArchive: boolean }) {
  const [state, action] = useActionState(updateTaxRateAction, idle)
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {canEdit && !taxRate.archived && (
        <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close' : 'Edit'}</Button>
      )}
      {canArchive && (
        <form action={setTaxRateArchivedAction}>
          <input type="hidden" name="id" value={taxRate.id} />
          <input type="hidden" name="archived" value={String(!taxRate.archived)} />
          <Button type="submit" size="sm" variant="ghost">{taxRate.archived ? 'Restore' : 'Archive'}</Button>
        </form>
      )}
      {open && (
        <form action={action} className="mt-2 grid w-full gap-3 text-left sm:grid-cols-[2fr_1fr_3fr]" noValidate>
          <input type="hidden" name="id" value={taxRate.id} />
          <TextField state={state} id={`tax-${taxRate.id}-name`} name="name" label="Name" defaultValue={taxRate.name} />
          <TextField state={state} id={`tax-${taxRate.id}-rate`} name="rate" label="Rate (%)" defaultValue={taxRate.rate} />
          <TextField state={state} id={`tax-${taxRate.id}-description`} name="description" label="Description" defaultValue={taxRate.description} />
          <div className="flex items-center gap-3 sm:col-span-3">
            <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
            <FormMessage state={state} />
          </div>
        </form>
      )}
    </div>
  )
}

// Services

export type ServiceValues = {
  id?: string
  name: string
  description: string | null
  pricingModel: string
  billingType: string
  unit: string | null
  currency: string
  /** Decimal string in `currency`. */
  defaultPrice: string
  defaultTaxRateId: string | null
}

function ServiceFields({ state, service, taxRates, prefix }: { state: ActionState<unknown>; service: ServiceValues; taxRates: TaxChoice[]; prefix: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <TextField state={state} id={`${prefix}-name`} name="name" label="Name" defaultValue={service.name} placeholder="Website design" />
      <SelectField state={state} id={`${prefix}-pricingModel`} name="pricingModel" label="Pricing" defaultValue={service.pricingModel} options={options(PRICING_MODEL_LABELS)} />
      <SelectField state={state} id={`${prefix}-billingType`} name="billingType" label="Billing" defaultValue={service.billingType} options={options(BILLING_TYPE_LABELS)} />
      <TextField state={state} id={`${prefix}-unit`} name="unit" label="Unit" defaultValue={service.unit} placeholder="hour" />
      <div className="grid grid-cols-[1fr_5rem] gap-2">
        <TextField state={state} id={`${prefix}-defaultPrice`} name="defaultPrice" label="Standard price" defaultValue={service.defaultPrice} placeholder="150.00" />
        <TextField state={state} id={`${prefix}-currency`} name="currency" label="Currency" defaultValue={service.currency} />
      </div>
      <SelectField
        state={state}
        id={`${prefix}-defaultTaxRateId`}
        name="defaultTaxRateId"
        label="Default tax"
        defaultValue={service.defaultTaxRateId}
        empty="No tax"
        options={taxRates.map((t) => ({ value: t.id, label: taxLabel(t) }))}
      />
      <div className="sm:col-span-2">
        <TextField state={state} id={`${prefix}-description`} name="description" label="Description" defaultValue={service.description} placeholder="Optional" />
      </div>
    </div>
  )
}

export function CreateServiceForm({ taxRates, currency }: { taxRates: TaxChoice[]; currency: string }) {
  const [state, action] = useActionState(createServiceAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <ServiceFields
        state={state}
        prefix="new-service"
        taxRates={taxRates}
        service={{ name: '', description: null, pricingModel: 'fixed', billingType: 'one_off', unit: null, currency, defaultPrice: '', defaultTaxRateId: null }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Adding…">Add service</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function ServiceControls({ service, taxRates, canEdit, canArchive, archived }: { service: ServiceValues & { id: string }; taxRates: TaxChoice[]; canEdit: boolean; canArchive: boolean; archived: boolean }) {
  const [state, action] = useActionState(updateServiceAction, idle)
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {canEdit && !archived && (
        <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close' : 'Edit'}</Button>
      )}
      {canArchive && (
        <form action={setServiceArchivedAction}>
          <input type="hidden" name="id" value={service.id} />
          <input type="hidden" name="archived" value={String(!archived)} />
          <Button type="submit" size="sm" variant="ghost">{archived ? 'Restore' : 'Archive'}</Button>
        </form>
      )}
      {open && (
        <form action={action} className="mt-2 w-full space-y-3 text-left" noValidate>
          <input type="hidden" name="id" value={service.id} />
          <ServiceFields state={state} prefix={`service-${service.id}`} taxRates={taxRates} service={service} />
          <div className="flex items-center gap-3">
            <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
            <FormMessage state={state} />
          </div>
        </form>
      )}
    </div>
  )
}

// Quotes

export function CreateQuoteForm({ companies, companyId, deal, currency, validUntil }: { companies: Choice[]; companyId: string | null; deal: { id: string; name: string; companyName: string } | null; currency: string; validUntil: string }) {
  const [state, action] = useActionState(createQuoteAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      {deal && <input type="hidden" name="dealId" value={deal.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="title" label="Title" required placeholder="Website rebuild" defaultValue={deal?.name} />
        {deal ? (
          <Field id="client" label="Client">
            <p id="client" className="py-2 text-sm">{deal.companyName}, for the deal &ldquo;{deal.name}&rdquo;</p>
          </Field>
        ) : (
          <SelectField state={state} name="companyId" label="Client" defaultValue={companyId} empty="Choose a client" options={choices(companies)} />
        )}
        <TextField state={state} name="currency" label="Currency" defaultValue={currency} />
        <SelectField state={state} name="taxMode" label="Tax" defaultValue="exclusive" options={options(TAX_MODE_LABELS)} />
        <TextField state={state} name="validUntil" label="Valid until" type="date" defaultValue={validUntil} />
      </div>
      <SubmitButton pendingLabel="Creating…">Create draft</SubmitButton>
    </form>
  )
}

export type QuoteDetails = {
  id: string
  title: string
  contactId: string | null
  currency: string
  taxMode: string
  validUntil: string
  discountPercent: string | null
  /** Decimal string in the quote's currency. */
  discountAmount: string | null
  notes: string | null
  terms: string | null
  hasLines: boolean
}

export function QuoteDetailsForm({ quote, contacts }: { quote: QuoteDetails; contacts: Choice[] }) {
  const [state, action] = useActionState(updateQuoteAction, idle)
  const [discountType, setDiscountType] = useState(quote.discountPercent !== null ? 'percent' : quote.discountAmount !== null ? 'amount' : 'none')
  const discountError = fieldError(state, 'discountValue')
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="id" value={quote.id} />
      <input type="hidden" name="currency" value={quote.currency} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="title" label="Title" defaultValue={quote.title} />
        <SelectField state={state} name="contactId" label="Contact" defaultValue={quote.contactId} empty="No contact" options={choices(contacts)} />
        <SelectField state={state} name="taxMode" label="Tax" defaultValue={quote.taxMode} options={options(TAX_MODE_LABELS)} />
        <TextField state={state} name="validUntil" label="Valid until" type="date" defaultValue={quote.validUntil} />
        {!quote.hasLines && <TextField state={state} name="newCurrency" label="Currency" defaultValue={quote.currency} hint="Fixed once the quote has lines." />}
        <div className="grid grid-cols-[9rem_1fr] gap-2">
          <Field id="discountType" label="Discount">
            <Select id="discountType" name="discountType" value={discountType} onChange={(e) => setDiscountType(e.currentTarget.value)}>
              <option value="none">None</option>
              <option value="percent">Percentage</option>
              <option value="amount">Amount</option>
            </Select>
          </Field>
          {discountType !== 'none' && (
            <Field id="discountValue" label={discountType === 'percent' ? 'Percent off' : `Amount off (${quote.currency})`} error={discountError}>
              <Input
                id="discountValue"
                name="discountValue"
                defaultValue={initial(state, 'discountValue', discountType === 'percent' ? quote.discountPercent : quote.discountAmount)}
                aria-invalid={discountError ? true : undefined}
              />
            </Field>
          )}
        </div>
      </div>
      <TextAreaField state={state} name="notes" label="Notes to the client" defaultValue={quote.notes} />
      <TextAreaField state={state} name="terms" label="Terms" defaultValue={quote.terms} />
      <SubmitButton size="sm" pendingLabel="Saving…">Save details</SubmitButton>
    </form>
  )
}

export function AddLineForm({ quoteId, currency, services, taxRates }: { quoteId: string; currency: string; services: Array<Choice & { hint: string }>; taxRates: TaxChoice[] }) {
  const [state, action] = useActionState(addQuoteLineAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="id" value={quoteId} />
      <input type="hidden" name="currency" value={currency} />
      <div className="grid gap-3 sm:grid-cols-[2fr_3fr]">
        <SelectField state={state} id="add-serviceId" name="serviceId" label="Service" empty="None" options={services.map((s) => ({ value: s.id, label: `${s.name}${s.hint}` }))} />
        <TextField state={state} id="add-description" name="description" label="Description" placeholder="From the service if blank" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_2fr_1fr_2fr]">
        <TextField state={state} id="add-quantity" name="quantity" label="Qty" defaultValue="1" />
        <TextField state={state} id="add-unitAmount" name="unitAmount" label={`Unit price (${currency})`} placeholder="From the service" />
        <TextField state={state} id="add-discountPercent" name="discountPercent" label="Disc. %" />
        <SelectField
          state={state}
          id="add-taxRateId"
          name="taxRateId"
          label="Tax"
          defaultValue="default"
          options={[{ value: 'default', label: "Service's default" }, { value: '', label: 'No tax' }, ...taxRates.map((t) => ({ value: t.id, label: taxLabel(t) }))]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Adding…">Add line</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export type EditableLine = {
  id: string
  description: string
  quantity: string
  /** Decimal string in the quote's currency. */
  unitAmount: string
  discountPercent: string | null
  taxRateId: string | null
}

export function LineControls({ quoteId, currency, line, taxRates }: { quoteId: string; currency: string; line: EditableLine; taxRates: TaxChoice[] }) {
  const [state, action] = useActionState(updateQuoteLineAction, idle)
  const [open, setOpen] = useState(false)
  const prefix = `line-${line.id}`
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={`Edit ${line.description}`}>
        {open ? 'Close' : 'Edit'}
      </Button>
      <form action={removeQuoteLineAction}>
        <input type="hidden" name="id" value={line.id} />
        <input type="hidden" name="quoteId" value={quoteId} />
        <Button type="submit" size="sm" variant="ghost" aria-label={`Remove ${line.description}`}>Remove</Button>
      </form>
      {open && (
        <form action={action} className="mt-2 grid w-full gap-3 text-left sm:grid-cols-2 lg:grid-cols-[3fr_1fr_1.5fr_1fr_2fr]" noValidate>
          <input type="hidden" name="id" value={line.id} />
          <input type="hidden" name="quoteId" value={quoteId} />
          <input type="hidden" name="currency" value={currency} />
          <TextField state={state} id={`${prefix}-description`} name="description" label="Description" defaultValue={line.description} />
          <TextField state={state} id={`${prefix}-quantity`} name="quantity" label="Qty" defaultValue={line.quantity} />
          <TextField state={state} id={`${prefix}-unitAmount`} name="unitAmount" label={`Unit price (${currency})`} defaultValue={line.unitAmount} />
          <TextField state={state} id={`${prefix}-discountPercent`} name="discountPercent" label="Disc. %" defaultValue={line.discountPercent} />
          <SelectField
            state={state}
            id={`${prefix}-taxRateId`}
            name="taxRateId"
            label="Tax"
            defaultValue={line.taxRateId ?? ''}
            options={[{ value: '', label: 'No tax' }, ...taxRates.map((t) => ({ value: t.id, label: taxLabel(t) }))]}
          />
          <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-5">
            <SubmitButton size="sm" pendingLabel="Saving…">Save line</SubmitButton>
            <FormMessage state={state} />
          </div>
        </form>
      )}
    </div>
  )
}

export function SendQuoteForm({ quoteId, currency, baseCurrency }: { quoteId: string; currency: string; baseCurrency: string }) {
  const [state, action] = useActionState(sendQuoteAction, idle)
  const foreign = currency !== baseCurrency
  return (
    <form
      action={action}
      className="space-y-3"
      onSubmit={(e) => {
        if (!confirm('Send this quote? It takes its number now and can no longer be edited.')) e.preventDefault()
      }}
      noValidate
    >
      <input type="hidden" name="id" value={quoteId} />
      {foreign && (
        <TextField state={state} name="exchangeRate" label={`1 ${currency} in ${baseCurrency}`} hint="Fixed on the quote when it is sent." placeholder="1.52" />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Sending…">Mark as sent</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function AnswerControls({ quoteId }: { quoteId: string }) {
  const [state, action] = useActionState(answerQuoteAction, idle)
  const [declining, setDeclining] = useState(false)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <form action={action}>
          <input type="hidden" name="id" value={quoteId} />
          <input type="hidden" name="answer" value="accept" />
          <SubmitButton size="sm" pendingLabel="Saving…">Accepted</SubmitButton>
        </form>
        <Button type="button" size="sm" variant="secondary" aria-expanded={declining} onClick={() => setDeclining(!declining)}>Declined…</Button>
      </div>
      {declining && (
        <form action={action} className="space-y-2">
          <input type="hidden" name="id" value={quoteId} />
          <input type="hidden" name="answer" value="decline" />
          <TextField state={state} name="reason" label="Why? (optional)" />
          <SubmitButton size="sm" variant="danger" pendingLabel="Saving…">Record as declined</SubmitButton>
        </form>
      )}
      <FormMessage state={state} />
    </div>
  )
}

export function DuplicateQuoteButton({ quoteId }: { quoteId: string }) {
  return (
    <form action={duplicateQuoteAction}>
      <input type="hidden" name="id" value={quoteId} />
      <Button type="submit" size="sm" variant="secondary">Duplicate</Button>
    </form>
  )
}

export function DeleteDraftButton({ quoteId }: { quoteId: string }) {
  return (
    <form
      action={deleteQuoteAction}
      onSubmit={(e) => {
        if (!confirm('Delete this draft quote?')) e.preventDefault()
      }}
    >
      <input type="hidden" name="id" value={quoteId} />
      <Button type="submit" size="sm" variant="ghost">Delete draft</Button>
    </form>
  )
}
