'use client'

import { Button, Input, Select } from '@workloom/ui'
import { useActionState, useState } from 'react'
import {
  changePlanStatusAction,
  createPlanAction,
  deletePlanAction,
  deleteVisitAction,
  logVisitAction,
  updatePlanAction,
} from '@/lib/actions/service'
import { idle, type ActionState } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { MAINTENANCE_PLAN_STATUS_LABELS, MAINTENANCE_VISIT_KIND_LABELS } from '@/lib/service-labels'
import { SelectField, TextAreaField, TextField, type Choice } from '../crm/fields'
import { FormMessage, SubmitButton } from '../form-bits'

type Plan = {
  id: string
  companyId: string
  name: string
  description: string | null
  startedOn: string
  responseHours: number | null
  resolutionHours: number | null
  includedHours: string | null
  billingScheduleId: string | null
  ownerId: string | null
  notes: string | null
  items: Array<{ id: string; label: string }>
}

const choices = (items: Choice[]) => items.map((i) => ({ value: i.id, label: i.name }))

/**
 * What the plan includes.
 *
 * A list of plain lines rather than a link to the service catalogue: what a
 * client is promised ("weekly backups") and what the agency sells are not the
 * same list, and pretending they are makes both harder to edit.
 */
function Inclusions({ initial }: { initial: string[] }) {
  const [items, setItems] = useState(initial.length > 0 ? initial : [''])
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-ink">What it includes</legend>
      {items.map((item, i) => (
        <div key={i} className="flex gap-2">
          <Input
            name="items"
            defaultValue={item}
            placeholder="Security updates"
            aria-label={`Inclusion ${i + 1}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setItems(items.filter((_, index) => index !== i))}
            aria-label={`Remove inclusion ${i + 1}`}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" onClick={() => setItems([...items, ''])}>
        Add another
      </Button>
    </fieldset>
  )
}

function PlanFields({
  state,
  plan,
  companies,
  members,
  schedules,
}: {
  state: ActionState<unknown>
  plan?: Plan
  companies: Choice[]
  members: Choice[]
  schedules: Choice[]
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {!plan && <SelectField state={state} name="companyId" label="Client" options={choices(companies)} empty="Choose a client" />}
        <TextField state={state} name="name" label="Name" defaultValue={plan?.name} required placeholder="Website care plan" />
        <TextField state={state} name="startedOn" label="Started" type="date" defaultValue={plan?.startedOn} />
        <TextField
          state={state}
          name="responseHours"
          label="Response target (hours)"
          type="number"
          hint="Leave empty to use the defaults for each ticket's priority."
          defaultValue={plan?.responseHours?.toString() ?? ''}
        />
        <TextField
          state={state}
          name="resolutionHours"
          label="Resolution target (hours)"
          type="number"
          defaultValue={plan?.resolutionHours?.toString() ?? ''}
        />
        <TextField
          state={state}
          name="includedHours"
          label="Included hours each period"
          hint="Support hours the plan covers before extra work is billed."
          defaultValue={plan?.includedHours ?? ''}
        />
        <SelectField
          state={state}
          name="billingScheduleId"
          label="Billed by"
          hint="The recurring schedule that raises this plan's invoices."
          defaultValue={plan?.billingScheduleId}
          options={choices(schedules)}
          empty="Not billed automatically"
        />
        <SelectField state={state} name="ownerId" label="Account manager" defaultValue={plan?.ownerId} options={choices(members)} empty="Unassigned" />
      </div>
      <TextAreaField state={state} name="description" label="Description" defaultValue={plan?.description} />
      <Inclusions initial={(plan?.items ?? []).map((i) => i.label)} />
    </div>
  )
}

export function CreatePlanForm(props: { companies: Choice[]; members: Choice[]; schedules: Choice[] }) {
  const [state, action] = useActionState(createPlanAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <PlanFields state={state} {...props} />
      <SubmitButton pendingLabel="Creating…">Create plan</SubmitButton>
    </form>
  )
}

export function EditPlanForm({ plan, ...props }: { plan: Plan; companies: Choice[]; members: Choice[]; schedules: Choice[] }) {
  const [state, action] = useActionState(updatePlanAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="id" value={plan.id} />
      <FormMessage state={state} />
      <PlanFields state={state} plan={plan} {...props} />
      <TextAreaField state={state} name="notes" label="Internal notes" defaultValue={plan.notes} />
      <SubmitButton pendingLabel="Saving…">Save plan</SubmitButton>
    </form>
  )
}

export function PlanStatusControl({ id, status }: { id: string; status: string }) {
  const [state, action] = useActionState(changePlanStatusAction, idle)
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`plan-status-${id}`} className="sr-only">Plan status</label>
      <Select
        id={`plan-status-${id}`}
        name="status"
        defaultValue={status}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-8 w-36 text-[13px]"
      >
        {options(MAINTENANCE_PLAN_STATUS_LABELS).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </Select>
      <noscript>
        <Button type="submit" size="sm" variant="secondary">Change</Button>
      </noscript>
      {state.status === 'error' && <span role="alert" className="text-xs text-critical">{state.message}</span>}
    </form>
  )
}

export function DeletePlanButton({ id }: { id: string }) {
  const [, action] = useActionState(deletePlanAction, idle)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Deleting…">Delete</SubmitButton>
    </form>
  )
}

export function LogVisitForm({ planId, members, today }: { planId: string; members: Choice[]; today: string }) {
  const [state, action] = useActionState(logVisitAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="planId" value={planId} />
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextField state={state} name="summary" label="What was done" required placeholder="Applied core and plugin updates" />
        </div>
        <SelectField state={state} name="kind" label="Kind" defaultValue="other" options={options(MAINTENANCE_VISIT_KIND_LABELS)} />
        <TextField state={state} name="performedOn" label="When" type="date" defaultValue={today} />
        <TextField state={state} name="minutesSpent" label="Minutes" type="number" hint="Counts against the plan's included hours." />
        <SelectField state={state} name="performedBy" label="By" options={choices(members)} empty="You" />
        <div className="sm:col-span-2">
          <TextAreaField state={state} name="notes" label="Notes" />
        </div>
      </div>
      <SubmitButton size="sm" pendingLabel="Recording…">Record</SubmitButton>
    </form>
  )
}

export function DeleteVisitButton({ id, planId }: { id: string; planId: string }) {
  const [, action] = useActionState(deleteVisitAction, idle)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="planId" value={planId} />
      <SubmitButton variant="ghost" size="xs" pendingLabel="…">Delete</SubmitButton>
    </form>
  )
}
