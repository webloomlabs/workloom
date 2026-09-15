'use client'

import { Button, Select, Textarea } from '@workloom/ui'
import { useActionState, useState } from 'react'
import { deleteActivityAction, logActivityAction } from '@/lib/actions/crm'
import { idle } from '@/lib/actions/state'
import { ACTIVITY_TYPE_LABELS, options } from '@/lib/crm-labels'
import { FormMessage, SubmitButton, fieldError } from '../form-bits'

export type TimelineEntry = {
  id: string
  type: string
  body: string
  /** Preformatted on the server, so every viewer sees the same time. */
  when: string
  authorName: string | null
  /** Where else it is filed, e.g. "Deal: Website rebuild". */
  context: string | null
}

type Target = { target: 'companyId' | 'contactId' | 'leadId' | 'dealId'; targetId: string }

export function LogActivityForm({ target, targetId, returnTo }: Target & { returnTo: string }) {
  const [state, action] = useActionState(logActivityAction, idle)
  const [when, setWhen] = useState('')

  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="target" value={target} />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      {/* The browser knows the person's time zone; the server does not. */}
      <input type="hidden" name="occurredAt" value={when ? new Date(when).toISOString() : ''} />
      <label htmlFor={`body-${targetId}`} className="sr-only">What happened</label>
      <Textarea
        id={`body-${targetId}`}
        name="body"
        rows={2}
        placeholder="Add a note, or log a call, email, or meeting…"
        defaultValue={state.status === 'error' ? state.values?.body : ''}
        aria-invalid={fieldError(state, 'body') ? true : undefined}
      />
      {fieldError(state, 'body') && <p role="alert" className="text-xs text-red-600">{fieldError(state, 'body')}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`type-${targetId}`}>Type</label>
        {/* Sized by its wrapper: the shared control is full-width. */}
        <div className="w-32">
          <Select id={`type-${targetId}`} name="type" defaultValue="note" className="h-8 text-xs">
            {options(ACTIVITY_TYPE_LABELS).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          When
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="h-8 rounded-md border border-neutral-300 bg-white px-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
        <SubmitButton size="sm" pendingLabel="Saving…">Log</SubmitButton>
      </div>
      {state.status === 'error' && !fieldError(state, 'body') && <FormMessage state={state} />}
    </form>
  )
}

export function Timeline({ entries, canDelete, returnTo }: { entries: TimelineEntry[]; canDelete: boolean; returnTo: string }) {
  if (entries.length === 0) {
    return <p className="px-5 py-6 text-center text-sm text-neutral-500">Nothing logged yet.</p>
  }
  return (
    <ol className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {entries.map((entry) => (
        <li key={entry.id} className="px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="text-xs text-neutral-500">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">{ACTIVITY_TYPE_LABELS[entry.type] ?? entry.type}</span>
              {' · '}
              {entry.when}
              {entry.authorName && ` · ${entry.authorName}`}
              {entry.context && ` · ${entry.context}`}
            </div>
            {canDelete && (
              <form
                action={deleteActivityAction}
                onSubmit={(e) => {
                  if (!confirm('Delete this entry? This cannot be undone.')) e.preventDefault()
                }}
              >
                <input type="hidden" name="id" value={entry.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <Button type="submit" variant="ghost" size="sm" aria-label="Delete entry">Delete</Button>
              </form>
            )}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm">{entry.body}</p>
        </li>
      ))}
    </ol>
  )
}
