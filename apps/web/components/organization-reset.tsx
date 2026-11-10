'use client'

import { Alert, Button, Field, Input } from '@workloom/ui'
import { useActionState, useRef, useState } from 'react'
import {
  confirmOrganizationResetAction,
  requestOrganizationResetAction,
  type ResetCodeSent,
} from '@/lib/actions/organization-reset'
import { idle, type ActionState } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'

/**
 * Resetting the organization, for its owner.
 *
 * Two steps, in a modal: the owner's password, then a code emailed to them.
 * The server enforces both and who may ask; this only walks through them.
 * "Start again" remounts the flow, which forgets the code that was sent --
 * asking again sends a new one, and only the newest works.
 */
export function OrganizationResetButton({ organizationName }: { organizationName: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [attempt, setAttempt] = useState(0)

  return (
    <>
      <Button type="button" variant="danger" onClick={() => ref.current?.showModal()}>
        Reset organization…
      </Button>
      <dialog
        ref={ref}
        aria-label={`Reset ${organizationName}`}
        onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close() }}
        className="m-auto w-[min(30rem,calc(100%-2rem))] rounded-xl border border-line bg-surface p-0 text-left text-ink shadow-xl backdrop:bg-black/60"
      >
        <div className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">Reset {organizationName}</h2>
              <p className="mt-1 text-sm text-muted">Deletes every record and file. This cannot be undone.</p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => ref.current?.close()}>Close</Button>
          </div>
          <ResetFlow key={attempt} onRestart={() => setAttempt((n) => n + 1)} />
        </div>
      </dialog>
    </>
  )
}

function ResetFlow({ onRestart }: { onRestart: () => void }) {
  const [sent, request] = useActionState(requestOrganizationResetAction, idle as ActionState<ResetCodeSent>)
  const [done, confirm] = useActionState(confirmOrganizationResetAction, idle)

  if (done.status === 'success') {
    return (
      <div className="space-y-4">
        <FormMessage state={done} />
        <a href="/" className="text-sm font-medium text-accent hover:underline">Go to the dashboard</a>
      </div>
    )
  }

  if (sent.status === 'success' && sent.data) {
    return (
      <form action={confirm} className="space-y-4" noValidate>
        <p className="text-sm text-muted">
          <span className="font-medium text-ink">Step 2 of 2.</span> We emailed a six-digit code to{' '}
          <span className="text-ink">{sent.data.email}</span>. It works once, for the next 10 minutes.
        </p>
        <FormMessage state={done} />
        <Field id="reset-code" label="Code from the email" error={fieldError(done, 'code')}>
          <Input id="reset-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6}
            required autoFocus className="font-mono tracking-[0.3em]" aria-invalid={!!fieldError(done, 'code')} />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton variant="danger" pendingLabel="Deleting everything…">Delete all data</SubmitButton>
          <Button type="button" variant="ghost" size="sm" onClick={onRestart}>Start again</Button>
        </div>
      </form>
    )
  }

  return (
    <form action={request} className="space-y-4" noValidate>
      <Alert tone="warning">
        Take a database backup first if there is any chance you will want this data back. Nothing in Workloom can
        restore it.
      </Alert>
      <p className="text-sm text-muted">
        <span className="font-medium text-ink">Step 1 of 2.</span> Confirm it is you with your password. A code to
        finish will then be emailed to you.
      </p>
      <FormMessage state={sent} />
      <Field id="reset-password" label="Your password" error={fieldError(sent, 'password')}>
        <Input id="reset-password" name="password" type="password" autoComplete="current-password" required autoFocus
          aria-invalid={!!fieldError(sent, 'password')} />
      </Field>
      <SubmitButton variant="secondary" pendingLabel="Checking…">Email me a code</SubmitButton>
    </form>
  )
}
