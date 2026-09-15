'use client'

import { formatElapsed } from '@workloom/core/time'
import { Button, Field, Input, Select } from '@workloom/ui'
import Link from 'next/link'
import { useActionState, useEffect, useState } from 'react'
import { deleteEntryAction, logTimeAction, setRateAction, startTimerAction, stopTimerAction, updateEntryAction } from '@/lib/actions/time'
import { idle, type ActionState } from '@/lib/actions/state'
import { FormMessage, SubmitButton, fieldError } from '../form-bits'
import { initial, TextField } from '../crm/fields'

/** Active projects and their open tasks, for choosing where time goes. */
export type WorkGroup = { projectId: string; projectName: string; tasks: Array<{ id: string; title: string }> }

function WorkField({ state, groups, prefix }: { state: ActionState<unknown>; groups: WorkGroup[]; prefix: string }) {
  const error = fieldError(state, 'work')
  return (
    <Field id={`${prefix}-work`} label="Project or task" error={error}>
      <Select id={`${prefix}-work`} name="work" defaultValue={initial(state, 'work', '')} aria-invalid={error ? true : undefined}>
        <option value="">Choose…</option>
        {groups.map((g) => (
          <optgroup key={g.projectId} label={g.projectName}>
            <option value={`project:${g.projectId}`}>{g.projectName} (no task)</option>
            {g.tasks.map((t) => (
              <option key={t.id} value={`task:${t.id}`}>{t.title}</option>
            ))}
          </optgroup>
        ))}
      </Select>
    </Field>
  )
}

function BillableField({ state, prefix }: { state: ActionState<unknown>; prefix: string }) {
  return (
    <Field id={`${prefix}-billable`} label="Billable">
      <Select id={`${prefix}-billable`} name="billable" defaultValue={initial(state, 'billable', '')}>
        <option value="">Project default</option>
        <option value="yes">Billable</option>
        <option value="no">Not billable</option>
      </Select>
    </Field>
  )
}

/**
 * Starts a timer, on work chosen from a list or on one fixed piece of work
 * (`work`, e.g. `task:<id>`) such as the task being viewed.
 */
export function StartTimerForm({ groups = [], work }: { groups?: WorkGroup[]; work?: string }) {
  const [state, action] = useActionState(startTimerAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      {work ? <input type="hidden" name="work" value={work} /> : <WorkField state={state} groups={groups} prefix="timer" />}
      <TextField state={state} id="timer-description" name="description" label="What are you working on?" placeholder="Optional" />
      {!work && <BillableField state={state} prefix="timer" />}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Starting…">Start timer</SubmitButton>
        {state.status === 'error' && <FormMessage state={state} />}
      </div>
    </form>
  )
}

export function LogTimeForm({ groups = [], work, defaultDate }: { groups?: WorkGroup[]; work?: string; defaultDate: string }) {
  const [state, action] = useActionState(logTimeAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      {work ? <input type="hidden" name="work" value={work} /> : <WorkField state={state} groups={groups} prefix="log" />}
      <div className="grid grid-cols-2 gap-3">
        <TextField state={state} id="log-spentOn" name="spentOn" label="Date" type="date" defaultValue={defaultDate} />
        <TextField state={state} id="log-duration" name="duration" label="Time" placeholder="1:30" hint="1:30, 1.5, or 90m" />
      </div>
      <TextField state={state} id="log-description" name="description" label="Notes" placeholder="Optional" />
      {!work && <BillableField state={state} prefix="log" />}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" variant="secondary" pendingLabel="Logging…">Log time</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export type RunningEntry = {
  id: string
  projectId: string
  projectName: string
  taskId: string | null
  taskTitle: string | null
  startedAt: string
}

/** The caller's running timer, ticking, with a way to stop it. Shown in the header. */
export function RunningTimer({ entry }: { entry: RunningEntry }) {
  const [state, action] = useActionState(stopTimerAction, idle)
  const [elapsed, setElapsed] = useState<number | null>(null)
  useEffect(() => {
    const started = new Date(entry.startedAt).getTime()
    const tick = () => setElapsed((Date.now() - started) / 1000)
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [entry.startedAt])

  const href = entry.taskId ? `/projects/${entry.projectId}/tasks/${entry.taskId}` : `/projects/${entry.projectId}`
  return (
    <form action={action} role="status" aria-label="Running timer" className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 py-1 pl-2.5 pr-1 text-xs dark:border-green-900 dark:bg-green-950">
      <span aria-hidden className="size-2 animate-pulse rounded-full bg-green-600" />
      <Link href={href} className="max-w-40 truncate font-medium text-green-900 hover:underline dark:text-green-200">
        {entry.taskTitle ?? entry.projectName}
      </Link>
      {/* Rendered after mount: the server cannot know the viewer's clock. */}
      <span className="font-mono tabular-nums text-green-900 dark:text-green-200">{elapsed === null ? '…' : formatElapsed(elapsed)}</span>
      <Button type="submit" size="sm" variant="secondary" className="h-6 px-2 text-xs">Stop</Button>
      {state.status === 'error' && <span role="alert" className="text-red-600">{state.message}</span>}
    </form>
  )
}

export type EditableEntry = {
  id: string
  running: boolean
  spentOn: string
  /** "h:mm", empty while running. */
  duration: string
  description: string | null
  billable: boolean
}

export function EntryControls({ entry }: { entry: EditableEntry }) {
  const [state, action] = useActionState(updateEntryAction, idle)
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {entry.running && <StopEntryButton id={entry.id} />}
      <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Close' : 'Edit'}
      </Button>
      <form
        action={deleteEntryAction}
        onSubmit={(e) => {
          if (!confirm(entry.running ? 'Discard this running timer?' : 'Delete this time entry?')) e.preventDefault()
        }}
      >
        <input type="hidden" name="id" value={entry.id} />
        <Button type="submit" size="sm" variant="ghost">Delete</Button>
      </form>
      {open && (
        <form action={action} className="mt-2 grid w-full gap-3 rounded-md border border-neutral-200 p-3 text-left sm:grid-cols-[9rem_6rem_1fr] dark:border-neutral-800" noValidate>
          <input type="hidden" name="id" value={entry.id} />
          <TextField state={state} id={`entry-${entry.id}-spentOn`} name="spentOn" label="Date" type="date" defaultValue={entry.spentOn} />
          {entry.running ? <div /> : <TextField state={state} id={`entry-${entry.id}-duration`} name="duration" label="Time" defaultValue={entry.duration} />}
          <TextField state={state} id={`entry-${entry.id}-description`} name="description" label="Notes" defaultValue={entry.description} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="billable" value="yes" defaultChecked={entry.billable} /> Billable
          </label>
          <div className="flex items-center gap-3 sm:col-span-2">
            <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
            <FormMessage state={state} />
          </div>
        </form>
      )}
    </div>
  )
}

function StopEntryButton({ id }: { id: string }) {
  const [state, action] = useActionState(stopTimerAction, idle)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" size="sm" variant="secondary">Stop</Button>
      {state.status === 'error' && <span role="alert" className="text-xs text-red-600">{state.message}</span>}
    </form>
  )
}

/** One row of default rates: the organization's, or a person's. */
export function RateForm({ userId, name, currency, billableRate, costRate }: { userId: string | null; name: string; currency: string; billableRate: string; costRate: string }) {
  const [state, action] = useActionState(setRateAction, idle)
  const key = userId ?? 'organization'
  return (
    <form action={action} className="flex flex-wrap items-center justify-end gap-2">
      {userId && <input type="hidden" name="userId" value={userId} />}
      <input type="hidden" name="currency" value={currency} />
      <label className="sr-only" htmlFor={`bill-${key}`}>Billable rate for {name}</label>
      <div className="w-28">
        <Input id={`bill-${key}`} name="billableRate" defaultValue={initial(state, 'billableRate', billableRate)} placeholder="Bill/h" className="h-8 text-xs" />
      </div>
      <label className="sr-only" htmlFor={`cost-${key}`}>Cost rate for {name}</label>
      <div className="w-28">
        <Input id={`cost-${key}`} name="costRate" defaultValue={initial(state, 'costRate', costRate)} placeholder="Cost/h" className="h-8 text-xs" />
      </div>
      <SubmitButton size="sm" variant="secondary" pendingLabel="…">Save</SubmitButton>
      {state.status === 'error' && <span role="alert" className="text-xs text-red-600">{fieldError(state, 'billableRate') ?? fieldError(state, 'costRate') ?? state.message}</span>}
      {state.status === 'success' && <span role="status" className="text-xs text-green-700">Saved</span>}
    </form>
  )
}
