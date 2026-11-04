'use client'

import { Field, Input, Select } from '@workloom/ui'
import { useActionState, useState } from 'react'
import { updateDocumentSequenceAction } from '@/lib/actions/settings'
import { idle } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'

type Sequence = { kind: 'invoice' | 'quote' | 'ticket' | 'expense'; format: string; reset: 'never' | 'yearly' | 'fiscal_yearly'; nextValue: number; nextNumber: string }

/** The same tokens the server prints with, for a live preview against today's date. */
function preview(format: string, value: number): string {
  const today = new Date()
  const year = String(today.getFullYear())
  return format.replace(/\{(YYYY|YY|FY|N+)\}/g, (_, token: string) => {
    if (token === 'YYYY') return year
    if (token === 'YY') return year.slice(2)
    if (token === 'FY') return 'FY'
    return String(value).padStart(token.length, '0')
  })
}

export function SequenceForm({ sequence, canEdit }: { sequence: Sequence; canEdit: boolean }) {
  const [state, action] = useActionState(updateDocumentSequenceAction, idle)
  const [format, setFormat] = useState(sequence.format)
  const [next, setNext] = useState(String(sequence.nextValue))
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="kind" value={sequence.kind} />
      <fieldset disabled={!canEdit} className="grid gap-5 sm:grid-cols-3">
        <Field id={`${sequence.kind}-format`} label="Format" hint="{YYYY} year, {FY} financial year, {NNNN} the counter." error={fieldError(state, 'format')}>
          <Input id={`${sequence.kind}-format`} name="format" value={format} onChange={(e) => setFormat(e.target.value)} className="font-mono" />
        </Field>
        <Field id={`${sequence.kind}-reset`} label="Start again from 1" error={fieldError(state, 'reset')}>
          <Select id={`${sequence.kind}-reset`} name="reset" defaultValue={sequence.reset}>
            <option value="never">Never</option>
            <option value="yearly">Every calendar year</option>
            <option value="fiscal_yearly">Every financial year</option>
          </Select>
        </Field>
        <Field id={`${sequence.kind}-next`} label="Next number" hint="Where the count stands for this year." error={fieldError(state, 'nextValue')}>
          <Input id={`${sequence.kind}-next`} name="nextValue" value={next} onChange={(e) => setNext(e.target.value)} inputMode="numeric" />
        </Field>
      </fieldset>
      <p className="text-sm text-muted">
        Preview: <span className="font-mono text-ink">{preview(format, Number(next) || 1)}</span>
      </p>
      {canEdit ? <SubmitButton pendingLabel="Saving…">Save numbering</SubmitButton> : null}
    </form>
  )
}
