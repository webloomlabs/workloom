'use client'

import { useActionState } from 'react'
import { lockBooksAction, requestTaxPackAction, unlockBooksAction } from '@/lib/actions/books'
import { idle } from '@/lib/actions/state'
import { TextField } from './crm/fields'
import { FormMessage, SubmitButton } from './form-bits'

export function RequestPackForm({ startYear, label }: { startYear: number; label: string }) {
  const [state, action] = useActionState(requestTaxPackAction, idle)
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="startYear" value={startYear} />
      <SubmitButton pendingLabel="Asking…">Make the {label} pack</SubmitButton>
      <FormMessage state={state} />
    </form>
  )
}

export function LockBooksForm({ through }: { through: string }) {
  const [state, action] = useActionState(lockBooksAction, idle)
  return (
    <form
      action={action}
      className="space-y-3"
      noValidate
      onSubmit={(e) => {
        if (!window.confirm(`Close the books through ${through}? Nothing dated on or before it can then be added, changed, or removed until an owner reopens them.`)) e.preventDefault()
      }}
    >
      <input type="hidden" name="through" value={through} />
      <TextField state={state} id="lock-reason" name="reason" label="Why" placeholder="Year of assessment filed" required />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="secondary" pendingLabel="Closing…">Close the books through {through}</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function UnlockBooksForm({ lockedThrough }: { lockedThrough: string }) {
  const [state, action] = useActionState(unlockBooksAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField state={state} id="unlock-reason" name="reason" label="Why reopen" placeholder="A late supplier invoice" required />
        <TextField state={state} id="unlock-to" name="to" type="date" label={`Close through an earlier day instead (before ${lockedThrough})`} hint="Leave empty to open everything." />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="secondary" pendingLabel="Reopening…">Reopen the books</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
