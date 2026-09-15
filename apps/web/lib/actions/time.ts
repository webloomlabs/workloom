'use server'

import { AmountFormatError, parseAmount } from '@workloom/core'
import { rateSet, timeEntryCreate, timeEntryDelete, timeEntryUpdate, timerStart, timerStop } from '@workloom/core/modules'
import { parseDuration } from '@workloom/core/time'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/**
 * Time tracking form actions. As elsewhere: read the form, call a procedure.
 * Durations are typed the way people write them ("1:30", "1.5", "90m") and
 * sent to the procedure as seconds.
 */

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
const id = (form: FormData, name = 'id') => z.uuid().parse(form.get(name))

class FieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message)
  }
}

/** Procedure fields that the forms present under another name. */
const FORM_FIELDS: Record<string, string> = {
  durationSeconds: 'duration',
  projectId: 'work',
  taskId: 'work',
  billableRateMinor: 'billableRate',
  costRateMinor: 'costRate',
}

function failed(error: unknown, form: FormData): ActionState<never> {
  const values: Record<string, string> = {}
  for (const [key, value] of form) if (typeof value === 'string' && !key.startsWith('$')) values[key] = value
  const state =
    error instanceof FieldError
      ? { status: 'error' as const, message: 'Please correct the highlighted fields.', fieldErrors: { [error.field]: error.message } }
      : toActionError(error)
  if (state.status !== 'error') return state
  const fieldErrors = state.fieldErrors
    ? Object.fromEntries(Object.entries(state.fieldErrors).map(([key, message]) => [FORM_FIELDS[key] ?? key, message]))
    : undefined
  return { ...state, ...(fieldErrors ? { fieldErrors } : {}), values }
}

/** The work picker's value: `project:<id>` or `task:<id>`. */
function work(form: FormData): { projectId?: string; taskId?: string } {
  const [kind, value] = text(form, 'work').split(':')
  const parsed = z.uuid().safeParse(value)
  if (parsed.success && kind === 'task') return { taskId: parsed.data }
  if (parsed.success && kind === 'project') return { projectId: parsed.data }
  throw new FieldError('work', 'Choose a project or a task.')
}

function duration(form: FormData): number {
  const seconds = parseDuration(text(form, 'duration'))
  if (seconds === null) throw new FieldError('duration', 'Enter a duration such as 1:30, 1.5, or 90m.')
  return seconds
}

/** "" follows the project: billable for client work, not for internal. */
function billable(form: FormData): boolean | undefined {
  const value = text(form, 'billable')
  return value === 'yes' ? true : value === 'no' ? false : undefined
}

function rate(form: FormData, name: string, currency: string): number | null {
  const raw = text(form, name)
  if (raw === '') return null
  try {
    return parseAmount(raw, currency)
  } catch (error) {
    if (error instanceof AmountFormatError) throw new FieldError(name, error.message)
    throw error
  }
}

// A running timer shows in the header on every page, and logged time appears
// on the timesheet, the task, and the project: refresh everything.
const refresh = () => revalidatePath('/', 'layout')

export async function startTimerAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(timerStart, { ...work(form), description: text(form, 'description'), billable: billable(form) })
  } catch (error) {
    return failed(error, form)
  }
  refresh()
  return { status: 'success', message: 'Timer started.' }
}

export async function stopTimerAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(timerStop, form.has('id') ? { id: id(form) } : {})
  } catch (error) {
    return failed(error, form)
  }
  refresh()
  return { status: 'idle' }
}

export async function logTimeAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(timeEntryCreate, {
      ...work(form),
      spentOn: text(form, 'spentOn') || undefined,
      durationSeconds: duration(form),
      description: text(form, 'description'),
      billable: billable(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  refresh()
  return { status: 'success', message: 'Time logged.' }
}

export async function updateEntryAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(timeEntryUpdate, {
      id: id(form),
      ...(form.has('work') ? work(form) : {}),
      ...(form.has('spentOn') ? { spentOn: text(form, 'spentOn') } : {}),
      ...(form.has('duration') ? { durationSeconds: duration(form) } : {}),
      description: text(form, 'description'),
      billable: form.get('billable') === 'yes',
    })
  } catch (error) {
    return failed(error, form)
  }
  refresh()
  return { status: 'success', message: 'Saved.' }
}

export async function deleteEntryAction(form: FormData): Promise<void> {
  await call(timeEntryDelete, { id: id(form) })
  refresh()
}

export async function setRateAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const currency = text(form, 'currency')
    const userId = text(form, 'userId')
    await call(rateSet, {
      userId: userId ? z.uuid().parse(userId) : null,
      currency,
      billableRateMinor: rate(form, 'billableRate', currency),
      costRateMinor: rate(form, 'costRate', currency),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/settings/rates')
  return { status: 'success', message: 'Saved.' }
}
