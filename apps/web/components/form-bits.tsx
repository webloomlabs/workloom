'use client'

import { Alert, Button, type ButtonProps } from '@workloom/ui'
import { useFormStatus } from 'react-dom'
import type { ActionState } from '@/lib/actions/state'

/** A submit button that disables itself while its form is pending. */
export function SubmitButton({ children, pendingLabel, ...props }: ButtonProps & { pendingLabel?: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending || props.disabled} aria-busy={pending} {...props}>
      {pending ? (pendingLabel ?? 'Working…') : children}
    </Button>
  )
}

/** The form-level outcome of an action. Field errors render beside their fields. */
export function FormMessage({ state }: { state: ActionState<unknown> }) {
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>
  if (state.status === 'success' && state.message) return <Alert tone="success">{state.message}</Alert>
  return null
}

export function fieldError(state: ActionState<unknown>, field: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[field] : undefined
}
