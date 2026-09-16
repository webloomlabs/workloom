'use client'

import { Field, Input, Textarea } from '@workloom/ui'
import { useActionState } from 'react'
import { updateOrganizationAction } from '@/lib/actions/settings'
import { idle } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'

type Organization = {
  name: string
  baseCurrency: string
  timezone: string
  dateFormat: string
  legalName: string | null
  billingAddress: string | null
  taxNumber: string | null
  paymentInstructions: string | null
  paymentTermsDays: number
}

export function OrganizationForm({
  organization,
  canEdit,
  timezones,
}: {
  organization: Organization
  canEdit: boolean
  /**
   * From the server. Browsers and Node ship different time zone data, so a list
   * built here would differ between the server render and hydration.
   */
  timezones: string[]
}) {
  const [state, action] = useActionState(updateOrganizationAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <fieldset disabled={!canEdit} className="grid gap-5 sm:grid-cols-2">
        <Field id="name" label="Name" error={fieldError(state, 'name')}>
          <Input id="name" name="name" defaultValue={organization.name} required />
        </Field>
        <Field id="baseCurrency" label="Base currency"
          hint="ISO code, e.g. AUD. Existing records keep the currency they were issued in."
          error={fieldError(state, 'baseCurrency')}>
          <Input id="baseCurrency" name="baseCurrency" defaultValue={organization.baseCurrency}
            maxLength={3} className="uppercase" />
        </Field>
        <Field id="timezone" label="Time zone"
          hint="Decides when an invoice becomes overdue. For example Australia/Sydney."
          error={fieldError(state, 'timezone')}>
          <Input id="timezone" name="timezone" defaultValue={organization.timezone} list="timezones" />
        </Field>
        <Field id="dateFormat" label="Date format" error={fieldError(state, 'dateFormat')}>
          <Input id="dateFormat" name="dateFormat" defaultValue={organization.dateFormat} />
        </Field>
      </fieldset>
      <fieldset disabled={!canEdit} className="space-y-5 border-t border-neutral-200 pt-5 dark:border-neutral-800">
        <legend className="text-sm font-semibold">On quotes and invoices</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="legalName" label="Legal name" hint="The name documents are issued under, if it differs." error={fieldError(state, 'legalName')}>
            <Input id="legalName" name="legalName" defaultValue={organization.legalName ?? ''} />
          </Field>
          <Field id="taxNumber" label="Tax number" hint="ABN, VAT number, or local equivalent." error={fieldError(state, 'taxNumber')}>
            <Input id="taxNumber" name="taxNumber" defaultValue={organization.taxNumber ?? ''} />
          </Field>
          <Field id="billingAddress" label="Address" error={fieldError(state, 'billingAddress')}>
            <Textarea id="billingAddress" name="billingAddress" rows={3} defaultValue={organization.billingAddress ?? ''} />
          </Field>
          <Field id="paymentInstructions" label="How to pay" hint="Bank details or instructions, printed on every invoice." error={fieldError(state, 'paymentInstructions')}>
            <Textarea id="paymentInstructions" name="paymentInstructions" rows={3} defaultValue={organization.paymentInstructions ?? ''} />
          </Field>
          <Field id="paymentTermsDays" label="Payment terms (days)" hint="The due date on a new invoice, counted from its issue date." error={fieldError(state, 'paymentTermsDays')}>
            <Input id="paymentTermsDays" name="paymentTermsDays" defaultValue={String(organization.paymentTermsDays)} inputMode="numeric" />
          </Field>
        </div>
      </fieldset>
      <datalist id="timezones">
        {timezones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      {canEdit ? (
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
      ) : (
        <p className="text-sm text-neutral-500">Only owners and admins can change these settings.</p>
      )}
    </form>
  )
}
