'use client'

import { Field, Input } from '@workloom/ui'
import { useActionState } from 'react'
import { createOrganizationAction } from '@/lib/actions/auth'
import { idle } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'

export function CreateOrganizationForm() {
  const [state, action] = useActionState(createOrganizationAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field id="name" label="Organization name" hint="Usually your agency's trading name." error={fieldError(state, 'name')}>
        <Input id="name" name="name" required placeholder="Webloom Labs" aria-invalid={!!fieldError(state, 'name')} />
      </Field>
      <SubmitButton pendingLabel="Creating…">Create organization</SubmitButton>
    </form>
  )
}
