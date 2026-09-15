import 'server-only'
import { authErrorMessage } from '@workloom/auth'
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '@workloom/core'
import { unstable_rethrow } from 'next/navigation'
import { ZodError } from 'zod'
import type { ActionState } from './state.ts'

/**
 * Turns anything thrown during an action into something safe to show.
 *
 * Messages from DomainError and Better Auth are written for the user and shown
 * verbatim. Everything else is logged and replaced with a generic message:
 * database errors can carry table names and fragments of other rows.
 */
export function toActionError(error: unknown): ActionState<never> {
  // redirect() and notFound() work by throwing. Swallowing them here would
  // silently cancel the navigation.
  unstable_rethrow(error)

  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of error.issues) {
      const key = String(issue.path[0] ?? 'form')
      fieldErrors[key] ??= issue.message
    }
    return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors }
  }
  if (error instanceof DomainError) {
    return {
      status: 'error',
      message: error.message,
      ...(error.field ? { fieldErrors: { [error.field]: error.message } } : {}),
    }
  }
  if (error instanceof ConflictError) {
    return { status: 'error', message: error.message }
  }
  if (error instanceof ForbiddenError) {
    return { status: 'error', message: "You don't have permission to do that." }
  }
  if (error instanceof NotFoundError) {
    return { status: 'error', message: 'That no longer exists.' }
  }

  const authMessage = authErrorMessage(error)
  if (authMessage) return { status: 'error', message: authMessage }

  console.error('[action] unexpected error', error)
  return { status: 'error', message: 'Something went wrong. Please try again.' }
}
