'use client'

import { Field, Input } from '@workloom/ui'
import Link from 'next/link'
import { useActionState } from 'react'
import {
  requestPasswordResetAction,
  resetPasswordAction,
  signInAction,
  signUpAction,
} from '@/lib/actions/auth'
import { idle } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'

function nextQuery(next?: string) {
  return next ? `?next=${encodeURIComponent(next)}` : ''
}

export function SignInForm({ next, notice, canSignUp }: {
  next?: string
  notice?: string
  /** False on a single-tenant installation, where accounts come from an admin. */
  canSignUp: boolean
}) {
  const [state, action] = useActionState(signInAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      {notice && state.status === 'idle' && <p className="text-sm text-green-700">{notice}</p>}
      <FormMessage state={state} />
      <input type="hidden" name="next" value={next ?? ''} />
      <Field id="email" label="Email" error={fieldError(state, 'email')}>
        <Input id="email" name="email" type="email" autoComplete="email" required
          aria-invalid={!!fieldError(state, 'email')} />
      </Field>
      <Field id="password" label="Password" error={fieldError(state, 'password')}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required
          aria-invalid={!!fieldError(state, 'password')} />
      </Field>
      <SubmitButton className="w-full" pendingLabel="Signing in…">Sign in</SubmitButton>
      <div className="flex justify-between text-sm">
        <Link href="/forgot-password" className="text-neutral-600 hover:underline">Forgot password?</Link>
        {canSignUp && (
          <Link href={`/sign-up${nextQuery(next)}`} className="font-medium hover:underline">Create an account</Link>
        )}
      </div>
    </form>
  )
}

export function SignUpForm({ next, email }: { next?: string; email?: string }) {
  const [state, action] = useActionState(signUpAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="next" value={next ?? ''} />
      <Field id="name" label="Your name" error={fieldError(state, 'name')}>
        <Input id="name" name="name" autoComplete="name" required aria-invalid={!!fieldError(state, 'name')} />
      </Field>
      <Field id="email" label="Email" error={fieldError(state, 'email')}>
        <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={email}
          aria-invalid={!!fieldError(state, 'email')} />
      </Field>
      <Field id="password" label="Password" hint="At least 12 characters." error={fieldError(state, 'password')}>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={12}
          aria-invalid={!!fieldError(state, 'password')} />
      </Field>
      <SubmitButton className="w-full" pendingLabel="Creating account…">Create account</SubmitButton>
      <p className="text-center text-sm text-neutral-600">
        Already have an account?{' '}
        <Link href={`/sign-in${nextQuery(next)}`} className="font-medium hover:underline">Sign in</Link>
      </p>
    </form>
  )
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState(requestPasswordResetAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field id="email" label="Email" error={fieldError(state, 'email')}>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <SubmitButton className="w-full" pendingLabel="Sending…">Send reset link</SubmitButton>
      <p className="text-center text-sm">
        <Link href="/sign-in" className="text-neutral-600 hover:underline">Back to sign in</Link>
      </p>
    </form>
  )
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPasswordAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <Field id="password" label="New password" hint="At least 12 characters." error={fieldError(state, 'password')}>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={12} />
      </Field>
      <SubmitButton className="w-full" pendingLabel="Saving…">Set new password</SubmitButton>
    </form>
  )
}
