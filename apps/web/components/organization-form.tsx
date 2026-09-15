'use client'

import { Field, Input } from '@workloom/ui'
import { useActionState } from 'react'
import { updateOrganizationAction } from '@/lib/actions/settings'
import { idle } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'

type Organization = { name: string; baseCurrency: string; timezone: string; dateFormat: string }

export function OrganizationForm({ organization, canEdit }: { organization: Organization; canEdit: boolean }) {
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
      <datalist id="timezones">
        {Intl.supportedValuesOf('timeZone').map((zone) => (
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
