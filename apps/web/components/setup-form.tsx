'use client'

import { Field, Input } from '@workloom/ui'
import { useActionState } from 'react'
import { setupAction } from '@/lib/actions/setup'
import { idle } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'

export function SetupForm() {
  const [state, action] = useActionState(setupAction, idle)
  const values = state.status === 'error' ? state.values : undefined

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />

      <Field
        id="organizationName"
        label="Organization name"
        hint="Usually your agency's trading name."
        error={fieldError(state, 'organizationName')}
      >
        <Input id="organizationName" name="organizationName" required placeholder="Webloom Labs"
          defaultValue={values?.organizationName}
          aria-invalid={!!fieldError(state, 'organizationName')} />
      </Field>

      <Field id="name" label="Your name" error={fieldError(state, 'name')}>
        <Input id="name" name="name" autoComplete="name" required defaultValue={values?.name}
          aria-invalid={!!fieldError(state, 'name')} />
      </Field>

      <Field id="email" label="Email" error={fieldError(state, 'email')}>
        <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={values?.email}
          aria-invalid={!!fieldError(state, 'email')} />
      </Field>

      <Field id="password" label="Password" hint="At least 12 characters." error={fieldError(state, 'password')}>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={12}
          aria-invalid={!!fieldError(state, 'password')} />
      </Field>

      <SubmitButton className="w-full" pendingLabel="Setting up…">Create administrator</SubmitButton>
    </form>
  )
}
