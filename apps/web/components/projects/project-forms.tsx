'use client'

import { Button, Checkbox, Input, Select } from '@workloom/ui'
import { useActionState, useState } from 'react'
import {
  addMemberAction,
  changeProjectStatusAction,
  createMilestoneAction,
  createProjectAction,
  deleteMilestoneAction,
  removeMemberAction,
  setMilestoneCompletedAction,
  setProjectArchivedAction,
  updateMemberAction,
  updateProjectAction,
} from '@/lib/actions/projects'
import { idle, type ActionState } from '@/lib/actions/state'
import { FormMessage, SubmitButton, fieldError } from '../form-bits'
import { choices, OwnerField, SelectField, TextAreaField, TextField, type Choice } from '../crm/fields'
import { MEMBER_ROLE_LABELS, PROJECT_STATUS_LABELS, options } from './labels'

// Projects

export type ProjectFormValues = {
  id?: string
  name?: string
  description?: string | null
  companyId?: string | null
  dealId?: string | null
  status?: string
  startDate?: string | null
  dueDate?: string | null
  currency: string
  /** Decimal string, e.g. "25000.00". */
  budget?: string
  ownerId: string | null
}

function ProjectFields({
  state,
  project,
  members,
  companies,
  financial,
  creating,
}: {
  state: ActionState<unknown>
  project: ProjectFormValues
  members: Choice[]
  companies: Choice[]
  financial: boolean
  creating: boolean
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField state={state} name="name" label="Project name" required defaultValue={project.name} placeholder="Website rebuild" />
      <SelectField state={state} name="companyId" label="Client" defaultValue={project.companyId} empty="Internal project" options={choices(companies)} />
      {creating && (
        <SelectField
          state={state}
          name="status"
          label="Status"
          defaultValue={project.status ?? 'planning'}
          options={options(PROJECT_STATUS_LABELS).filter((o) => o.value !== 'completed')}
        />
      )}
      <OwnerField state={state} members={members} defaultValue={project.ownerId} />
      <TextField state={state} name="startDate" label="Start" type="date" defaultValue={project.startDate} />
      <TextField state={state} name="dueDate" label="Due" type="date" defaultValue={project.dueDate} />
      {financial && (
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <TextField state={state} name="budget" label="Budget" defaultValue={project.budget} placeholder="25,000.00" />
          <TextField state={state} name="currency" label="Currency" defaultValue={project.currency} />
        </div>
      )}
      <div className="sm:col-span-2">
        <TextAreaField state={state} name="description" label="Description" defaultValue={project.description} />
      </div>
    </div>
  )
}

export function CreateProjectForm(props: {
  project: ProjectFormValues
  members: Choice[]
  companies: Choice[]
  financial: boolean
  baseCurrency: string
}) {
  const [state, action] = useActionState(createProjectAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="baseCurrency" value={props.baseCurrency} />
      {props.project.dealId && <input type="hidden" name="dealId" value={props.project.dealId} />}
      <ProjectFields state={state} creating {...props} />
      <SubmitButton pendingLabel="Creating…">Create project</SubmitButton>
    </form>
  )
}

export function EditProjectForm(props: { project: ProjectFormValues & { id: string }; members: Choice[]; companies: Choice[]; financial: boolean }) {
  const [state, action] = useActionState(updateProjectAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="id" value={props.project.id} />
      <ProjectFields state={state} creating={false} {...props} />
      <SubmitButton pendingLabel="Saving…">Save project</SubmitButton>
    </form>
  )
}

export function ProjectStatusControl({ id, status }: { id: string; status: string }) {
  const [state, action] = useActionState(changeProjectStatusAction, idle)
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`project-status-${id}`} className="sr-only">Project status</label>
      <div className="w-40">
        <Select
          id={`project-status-${id}`}
          name="status"
          defaultValue={status}
          className="h-8 text-xs"
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
        >
          {options(PROJECT_STATUS_LABELS).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
      </div>
      <noscript><Button type="submit" size="sm" variant="secondary">Update</Button></noscript>
      <FormMessage state={state} />
    </form>
  )
}

export function ProjectArchiveControl({ id, archived }: { id: string; archived: boolean }) {
  const [state, action] = useActionState(setProjectArchivedAction, idle)
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!archived && !confirm('Archive this project? It will be hidden from lists and take no new work, and can be restored.')) e.preventDefault()
      }}
      className="space-y-2"
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="archived" value={String(!archived)} />
      <Button type="submit" size="sm" variant={archived ? 'secondary' : 'ghost'}>{archived ? 'Restore project' : 'Archive project'}</Button>
      <FormMessage state={state} />
    </form>
  )
}

// Team

export type MemberRow = {
  id: string
  userId: string
  name: string
  email: string
  role: string
  /** Decimal strings; empty when unset. */
  billableRate: string
  costRate: string
  /** A total for the project rather than an hourly rate. Empty when they are hourly. */
  fixedFee: string
}

export function AddMemberForm({ projectId, people, currency, financial }: { projectId: string; people: Choice[]; currency: string; financial: boolean }) {
  const [state, action] = useActionState(addMemberAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="currency" value={currency} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField state={state} name="userId" label="Person" empty="Choose someone" options={choices(people)} />
        <SelectField state={state} name="role" label="Role" defaultValue="member" options={options(MEMBER_ROLE_LABELS)} />
        {financial && (
          <>
            <TextField state={state} name="billableRate" label={`Billable rate (${currency}/h)`} hint="Blank uses their default." />
            <TextField state={state} name="costRate" label={`Cost rate (${currency}/h)`} />
            <TextField
              state={state}
              name="fixedFee"
              label={`Fixed fee (${currency})`}
              hint="A total for the project instead of an hourly cost. Their time then costs nothing per hour."
            />
          </>
        )}
      </div>
      <SubmitButton size="sm" pendingLabel="Adding…">Add to project</SubmitButton>
    </form>
  )
}

export function MemberControls({ member, projectId, currency, financial, canEdit }: { member: MemberRow; projectId: string; currency: string; financial: boolean; canEdit: boolean }) {
  const [state, action] = useActionState(updateMemberAction, idle)
  if (!canEdit) return null
  return (
    <div className="flex flex-wrap items-start justify-end gap-2">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={member.id} />
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="currency" value={currency} />
        <label className="sr-only" htmlFor={`role-${member.id}`}>Role for {member.name}</label>
        <div className="w-28">
          <Select id={`role-${member.id}`} name="role" defaultValue={member.role} className="h-8 text-xs">
            {options(MEMBER_ROLE_LABELS).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
        {financial && (
          <>
            {/* Sized by wrappers: the shared control is full-width. */}
            <label className="sr-only" htmlFor={`bill-${member.id}`}>Billable rate for {member.name}</label>
            <div className="w-24">
              <Input id={`bill-${member.id}`} name="billableRate" defaultValue={member.billableRate} placeholder="Bill/h" className="h-8 text-xs" />
            </div>
            <label className="sr-only" htmlFor={`cost-${member.id}`}>Cost rate for {member.name}</label>
            <div className="w-24">
              <Input id={`cost-${member.id}`} name="costRate" defaultValue={member.costRate} placeholder="Cost/h" className="h-8 text-xs" />
            </div>
            <label className="sr-only" htmlFor={`fee-${member.id}`}>Fixed fee for {member.name}</label>
            <div className="w-24">
              <Input id={`fee-${member.id}`} name="fixedFee" defaultValue={member.fixedFee} placeholder="Fixed fee" className="h-8 text-xs" />
            </div>
          </>
        )}
        <SubmitButton size="sm" variant="secondary" pendingLabel="…">Save</SubmitButton>
        {/* The procedure refuses a fee over time already costed by the hour, and
            names how many entries. Confirming rewrites them to cost nothing. */}
        {fieldError(state, 'fixedFeeMinor') && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <Checkbox name="rebaseLoggedCost" />
            Rewrite that logged time to cost nothing
          </label>
        )}
        {state.status === 'error' && (
          <span role="alert" className="text-xs text-critical">
            {fieldError(state, 'billableRate') ?? fieldError(state, 'costRate') ?? fieldError(state, 'fixedFeeMinor') ?? state.message}
          </span>
        )}
      </form>
      <form action={removeMemberAction}>
        <input type="hidden" name="id" value={member.id} />
        <input type="hidden" name="projectId" value={projectId} />
        <Button type="submit" size="sm" variant="ghost">Remove</Button>
      </form>
    </div>
  )
}

// Milestones

export function CreateMilestoneForm({ projectId, canPublish }: { projectId: string; canPublish: boolean }) {
  const [state, action] = useActionState(createMilestoneAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
        <TextField state={state} name="name" label="Milestone" placeholder="Design sign-off" />
        <TextField state={state} name="dueDate" label="Due" type="date" />
      </div>
      {canPublish && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="clientVisible" /> Visible to the client
        </label>
      )}
      <SubmitButton size="sm" pendingLabel="Adding…">Add milestone</SubmitButton>
    </form>
  )
}

export function MilestoneControls({ id, projectId, completed, canDelete }: { id: string; projectId: string; completed: boolean; canDelete: boolean }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="flex items-center justify-end gap-1">
      <form action={setMilestoneCompletedAction}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="completed" value={String(!completed)} />
        <Button type="submit" size="sm" variant="secondary">{completed ? 'Reopen' : 'Mark complete'}</Button>
      </form>
      {canDelete &&
        (confirming ? (
          <form action={deleteMilestoneAction}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="projectId" value={projectId} />
            <Button type="submit" size="sm" variant="danger">Delete milestone</Button>
          </form>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>Delete…</Button>
        ))}
    </div>
  )
}
