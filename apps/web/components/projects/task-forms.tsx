'use client'

import { Button, Select } from '@workloom/ui'
import { useActionState } from 'react'
import {
  addDependencyAction,
  changeTaskStatusAction,
  createTaskAction,
  deleteTaskAction,
  removeDependencyAction,
  updateTaskAction,
} from '@/lib/actions/projects'
import { idle } from '@/lib/actions/state'
import { FormMessage, SubmitButton, fieldError } from '../form-bits'
import { choices, SelectField, TextAreaField, TextField, type Choice } from '../crm/fields'
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS, options } from './labels'

export function QuickTaskForm({ projectId, members, milestones }: { projectId: string; members: Choice[]; milestones: Choice[] }) {
  const [state, action] = useActionState(createTaskAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr]">
        <TextField state={state} name="title" label="New task" placeholder="What needs doing?" />
        <SelectField state={state} name="assigneeId" label="Assignee" empty="Unassigned" options={choices(members)} />
        <SelectField state={state} name="priority" label="Priority" defaultValue="normal" options={options(TASK_PRIORITY_LABELS)} />
        <SelectField state={state} name="milestoneId" label="Milestone" empty="None" options={choices(milestones)} />
        <TextField state={state} name="dueDate" label="Due" type="date" />
      </div>
      <div className="flex items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Adding…">Add task</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export type EditableTask = {
  id: string
  projectId: string
  title: string
  description: string | null
  milestoneId: string | null
  assigneeId: string | null
  priority: string
  dueDate: string | null
  labels: string[]
  estimateHours: string
  clientVisible: boolean
}

export function EditTaskForm({ task, members, milestones, canPublish }: { task: EditableTask; members: Choice[]; milestones: Choice[]; canPublish: boolean }) {
  const [state, action] = useActionState(updateTaskAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="id" value={task.id} />
      <input type="hidden" name="projectId" value={task.projectId} />
      <TextField state={state} name="title" label="Title" required defaultValue={task.title} />
      <TextAreaField state={state} name="description" label="Description" defaultValue={task.description} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField state={state} name="assigneeId" label="Assignee" defaultValue={task.assigneeId} empty="Unassigned" options={choices(members)} />
        <SelectField state={state} name="priority" label="Priority" defaultValue={task.priority} options={options(TASK_PRIORITY_LABELS)} />
        <SelectField state={state} name="milestoneId" label="Milestone" defaultValue={task.milestoneId} empty="None" options={choices(milestones)} />
        <TextField state={state} name="dueDate" label="Due" type="date" defaultValue={task.dueDate} />
        <TextField state={state} name="labels" label="Labels" hint="Separated by commas." defaultValue={task.labels.join(', ')} />
        <TextField state={state} name="estimateHours" label="Estimate (hours)" defaultValue={task.estimateHours} placeholder="1.5" />
      </div>
      {canPublish && (
        <label className="flex items-center gap-2 text-sm">
          <input type="hidden" name="clientVisibleField" value="1" />
          <input type="checkbox" name="clientVisible" defaultChecked={task.clientVisible} /> Visible to the client
        </label>
      )}
      <SubmitButton pendingLabel="Saving…">Save task</SubmitButton>
    </form>
  )
}

/** Moves a task between statuses as soon as one is chosen. */
export function TaskStatusControl({ id, projectId, status, compact = false }: { id: string; projectId: string; status: string; compact?: boolean }) {
  const [state, action] = useActionState(changeTaskStatusAction, idle)
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="projectId" value={projectId} />
      <label htmlFor={`task-status-${id}`} className="sr-only">Status</label>
      <div className={compact ? undefined : 'w-40'}>
        <Select
          id={`task-status-${id}`}
          name="status"
          defaultValue={status}
          key={status}
          className="h-8 text-xs"
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
        >
          {options(TASK_STATUS_LABELS).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </div>
      <noscript><Button type="submit" size="sm" variant="secondary">Update</Button></noscript>
      {state.status === 'error' && <p role="alert" className="text-xs text-red-600">{fieldError(state, 'status') ?? state.message}</p>}
    </form>
  )
}

export function AddDependencyForm({ taskId, projectId, candidates }: { taskId: string; projectId: string; candidates: Choice[] }) {
  const [state, action] = useActionState(addDependencyAction, idle)
  if (candidates.length === 0) return <p className="text-sm text-neutral-500">No other tasks in this project to wait on.</p>
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={taskId} />
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <SelectField state={state} name="dependsOnTaskId" label="Waits on" empty="Choose a task" options={choices(candidates)} />
        </div>
        <SubmitButton size="sm" variant="secondary" pendingLabel="Adding…">Add</SubmitButton>
      </div>
      {state.status === 'error' && !fieldError(state, 'dependsOnTaskId') && <FormMessage state={state} />}
    </form>
  )
}

export function RemoveDependencyButton({ taskId, projectId, dependsOnTaskId, title }: { taskId: string; projectId: string; dependsOnTaskId: string; title: string }) {
  return (
    <form action={removeDependencyAction}>
      <input type="hidden" name="id" value={taskId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="dependsOnTaskId" value={dependsOnTaskId} />
      <Button type="submit" size="sm" variant="ghost" aria-label={`Stop waiting on ${title}`}>Remove</Button>
    </form>
  )
}

export function DeleteTaskButton({ id, projectId }: { id: string; projectId: string }) {
  return (
    <form
      action={deleteTaskAction}
      onSubmit={(e) => {
        if (!confirm('Delete this task, with its comments and files? This cannot be undone.')) e.preventDefault()
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="projectId" value={projectId} />
      <Button type="submit" size="sm" variant="ghost">Delete task</Button>
    </form>
  )
}
