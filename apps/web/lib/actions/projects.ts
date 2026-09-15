'use server'

import { AmountFormatError, parseAmount } from '@workloom/core'
import {
  attachmentDelete,
  attachmentUpload,
  commentCreate,
  commentDelete,
  milestoneCreate,
  milestoneDelete,
  milestoneUpdate,
  projectArchive,
  projectChangeStatus,
  projectCreate,
  projectMemberAdd,
  projectMemberRemove,
  projectMemberUpdate,
  projectRestore,
  projectUpdate,
  taskChangeStatus,
  taskCreate,
  taskDelete,
  taskDependencyAdd,
  taskDependencyRemove,
  taskUpdate,
} from '@workloom/core/modules'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/**
 * Project form actions. As with the CRM actions: read the form, call a
 * procedure, decide where to go. The rules live in the procedures.
 */

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
const maybe = (form: FormData, name: string) => (form.has(name) ? text(form, name) : undefined)
const nullable = (form: FormData, name: string) => (form.has(name) ? text(form, name) || null : undefined)
const id = (form: FormData, name = 'id') => z.uuid().parse(form.get(name))
const checked = (form: FormData, name: string) => form.get(name) === 'on'

class FieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message)
  }
}

function failed(error: unknown, form: FormData): ActionState<never> {
  const values: Record<string, string> = {}
  for (const [key, value] of form) if (typeof value === 'string' && !key.startsWith('$')) values[key] = value
  const state =
    error instanceof FieldError
      ? { status: 'error' as const, message: 'Please correct the highlighted fields.', fieldErrors: { [error.field]: error.message } }
      : toActionError(error)
  return state.status === 'error' ? { ...state, values } : state
}

/** An optional money field in a given currency. "" clears it. */
function money(form: FormData, name: string, currency: string): number | null | undefined {
  if (!form.has(name)) return undefined
  const raw = text(form, name)
  if (raw === '') return null
  try {
    return parseAmount(raw, currency)
  } catch (error) {
    if (error instanceof AmountFormatError) throw new FieldError(name, error.message)
    throw error
  }
}

/** Hours typed by a person ("1.5") as whole minutes. */
function minutes(form: FormData, name: string): number | null | undefined {
  if (!form.has(name)) return undefined
  const raw = text(form, name)
  if (raw === '') return null
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours < 0) throw new FieldError(name, 'Enter hours as a number, such as 1.5.')
  return Math.round(hours * 60)
}

const labels = (form: FormData) =>
  form.has('labels') ? text(form, 'labels').split(',').map((l) => l.trim()).filter(Boolean) : undefined

const projectPath = (projectId: string, tab?: string) => `/projects/${projectId}${tab ? `?tab=${tab}` : ''}`

// Projects

export async function createProjectAction(_: ActionState, form: FormData): Promise<ActionState> {
  let created: { id: string }
  try {
    const currency = text(form, 'currency').toUpperCase()
    created = await call(projectCreate, {
      name: text(form, 'name'),
      description: text(form, 'description'),
      companyId: text(form, 'companyId') || null,
      dealId: text(form, 'dealId') || null,
      status: (text(form, 'status') || 'planning') as never,
      startDate: text(form, 'startDate') || null,
      dueDate: text(form, 'dueDate') || null,
      ...(currency ? { currency } : {}),
      budgetMinor: money(form, 'budget', currency || text(form, 'baseCurrency')) ?? null,
      ownerId: nullable(form, 'ownerId'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/projects')
  redirect(projectPath(created.id))
}

export async function updateProjectAction(_: ActionState, form: FormData): Promise<ActionState> {
  const projectId = id(form)
  try {
    const currency = text(form, 'currency').toUpperCase()
    await call(projectUpdate, {
      id: projectId,
      name: maybe(form, 'name'),
      description: maybe(form, 'description'),
      companyId: nullable(form, 'companyId'),
      startDate: nullable(form, 'startDate'),
      dueDate: nullable(form, 'dueDate'),
      ...(currency ? { currency } : {}),
      budgetMinor: money(form, 'budget', currency),
      ownerId: nullable(form, 'ownerId'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(projectPath(projectId))
  return { status: 'success', message: 'Project saved.' }
}

export async function changeProjectStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const projectId = id(form)
  try {
    await call(projectChangeStatus, { id: projectId, status: text(form, 'status') as never })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(projectPath(projectId))
  revalidatePath('/projects')
  return { status: 'idle' }
}

export async function setProjectArchivedAction(_: ActionState, form: FormData): Promise<ActionState> {
  const projectId = id(form)
  try {
    await call(form.get('archived') === 'true' ? projectArchive : projectRestore, { id: projectId })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(projectPath(projectId))
  revalidatePath('/projects')
  return { status: 'idle' }
}

// Team

export async function addMemberAction(_: ActionState, form: FormData): Promise<ActionState> {
  const projectId = id(form, 'projectId')
  try {
    const currency = text(form, 'currency')
    await call(projectMemberAdd, {
      id: projectId,
      userId: z.uuid('Choose someone to add.').parse(form.get('userId') || undefined),
      role: (text(form, 'role') || 'member') as never,
      billableRateMinor: money(form, 'billableRate', currency),
      costRateMinor: money(form, 'costRate', currency),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(projectPath(projectId))
  return { status: 'success', message: 'Added to the project.' }
}

export async function updateMemberAction(_: ActionState, form: FormData): Promise<ActionState> {
  const projectId = id(form, 'projectId')
  try {
    const currency = text(form, 'currency')
    await call(projectMemberUpdate, {
      id: id(form),
      role: (maybe(form, 'role') || undefined) as never,
      billableRateMinor: money(form, 'billableRate', currency),
      costRateMinor: money(form, 'costRate', currency),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(projectPath(projectId))
  return { status: 'success', message: 'Saved.' }
}

export async function removeMemberAction(form: FormData): Promise<void> {
  await call(projectMemberRemove, { id: id(form) })
  revalidatePath(projectPath(id(form, 'projectId')))
}

// Milestones

export async function createMilestoneAction(_: ActionState, form: FormData): Promise<ActionState> {
  const projectId = id(form, 'projectId')
  try {
    await call(milestoneCreate, {
      id: projectId,
      name: text(form, 'name'),
      dueDate: text(form, 'dueDate') || null,
      clientVisible: checked(form, 'clientVisible'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(projectPath(projectId))
  return { status: 'success', message: 'Milestone added.' }
}

export async function setMilestoneCompletedAction(form: FormData): Promise<void> {
  await call(milestoneUpdate, { id: id(form), completed: form.get('completed') === 'true' })
  revalidatePath(projectPath(id(form, 'projectId')))
}

export async function deleteMilestoneAction(form: FormData): Promise<void> {
  await call(milestoneDelete, { id: id(form) })
  revalidatePath(projectPath(id(form, 'projectId')))
}

// Tasks

export async function createTaskAction(_: ActionState, form: FormData): Promise<ActionState> {
  const projectId = id(form, 'projectId')
  try {
    await call(taskCreate, {
      projectId,
      title: text(form, 'title'),
      assigneeId: text(form, 'assigneeId') || null,
      milestoneId: text(form, 'milestoneId') || null,
      priority: (text(form, 'priority') || 'normal') as never,
      dueDate: text(form, 'dueDate') || null,
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(projectPath(projectId))
  return { status: 'success', message: 'Task added.' }
}

export async function updateTaskAction(_: ActionState, form: FormData): Promise<ActionState> {
  const taskId = id(form)
  try {
    await call(taskUpdate, {
      id: taskId,
      title: maybe(form, 'title'),
      description: maybe(form, 'description'),
      milestoneId: nullable(form, 'milestoneId'),
      assigneeId: nullable(form, 'assigneeId'),
      priority: (maybe(form, 'priority') || undefined) as never,
      dueDate: nullable(form, 'dueDate'),
      labels: labels(form),
      estimateMinutes: minutes(form, 'estimateHours'),
      ...(form.has('clientVisibleField') ? { clientVisible: checked(form, 'clientVisible') } : {}),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/projects/${id(form, 'projectId')}/tasks/${taskId}`)
  return { status: 'success', message: 'Task saved.' }
}

export async function changeTaskStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const taskId = id(form)
  try {
    await call(taskChangeStatus, { id: taskId, status: text(form, 'status') as never })
  } catch (error) {
    return failed(error, form)
  }
  const projectId = id(form, 'projectId')
  revalidatePath(projectPath(projectId))
  revalidatePath(`/projects/${projectId}/tasks/${taskId}`)
  revalidatePath('/tasks')
  return { status: 'idle' }
}

export async function deleteTaskAction(form: FormData): Promise<void> {
  const projectId = id(form, 'projectId')
  await call(taskDelete, { id: id(form) })
  revalidatePath(projectPath(projectId))
  redirect(projectPath(projectId))
}

export async function addDependencyAction(_: ActionState, form: FormData): Promise<ActionState> {
  const taskId = id(form)
  try {
    await call(taskDependencyAdd, {
      id: taskId,
      dependsOnTaskId: z.uuid('Choose a task.').parse(form.get('dependsOnTaskId') || undefined),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/projects/${id(form, 'projectId')}/tasks/${taskId}`)
  return { status: 'idle' }
}

export async function removeDependencyAction(form: FormData): Promise<void> {
  const taskId = id(form)
  await call(taskDependencyRemove, { id: taskId, dependsOnTaskId: id(form, 'dependsOnTaskId') })
  revalidatePath(`/projects/${id(form, 'projectId')}/tasks/${taskId}`)
}

// Discussion and files

function returnPath(form: FormData): string {
  const path = text(form, 'returnTo')
  // Only paths within projects: this value is echoed into a revalidation.
  return /^\/projects\/[0-9a-f-]{36}(\/tasks\/[0-9a-f-]{36})?$/.test(path) ? path : '/projects'
}

export async function postCommentAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(commentCreate, {
      projectId: id(form, 'projectId'),
      taskId: text(form, 'taskId') || null,
      body: text(form, 'body'),
      clientVisible: checked(form, 'clientVisible'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(returnPath(form))
  return { status: 'success', message: 'Posted.' }
}

export async function deleteCommentAction(form: FormData): Promise<void> {
  await call(commentDelete, { id: id(form) })
  revalidatePath(returnPath(form))
}

export async function uploadAttachmentAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const file = form.get('file')
    if (!(file instanceof File) || file.size === 0) throw new FieldError('file', 'Choose a file to upload.')
    await call(attachmentUpload, {
      projectId: id(form, 'projectId'),
      taskId: text(form, 'taskId') || null,
      file,
      clientVisible: checked(form, 'clientVisible'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(returnPath(form))
  return { status: 'success', message: 'Uploaded.' }
}

export async function deleteAttachmentAction(form: FormData): Promise<void> {
  await call(attachmentDelete, { id: id(form) })
  revalidatePath(returnPath(form))
}
