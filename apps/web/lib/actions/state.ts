/**
 * What a form's Server Action returns to `useActionState`.
 *
 * This file is imported by client components, so it must stay free of server
 * code: no @workloom/auth, @workloom/db, or @workloom/core imports. Error
 * mapping, which needs those, lives in ./errors.ts.
 */
export type ActionState<T = undefined> =
  | { status: 'idle' }
  | {
      status: 'error'
      message: string
      fieldErrors?: Record<string, string>
      /**
       * What was submitted. React resets a form after its action returns, so a
       * form that failed validation re-fills itself from these rather than
       * making the person type everything again.
       */
      values?: Record<string, string>
    }
  | { status: 'success'; message?: string; data?: T }

export const idle: ActionState<never> = { status: 'idle' }
