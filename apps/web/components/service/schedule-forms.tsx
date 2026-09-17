'use client'

import { Button, Select } from '@workloom/ui'
import { useActionState } from 'react'
import {
  addScheduleLineAction,
  changeScheduleStatusAction,
  createScheduleAction,
  deleteScheduleAction,
  generateInvoiceAction,
  removeScheduleLineAction,
  updateScheduleAction,
} from '@/lib/actions/service'
import { idle, type ActionState } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { TAX_MODE_LABELS } from '@/lib/finance-labels'
import { BILLING_INTERVAL_LABELS, BILLING_SCHEDULE_STATUS_LABELS } from '@/lib/service-labels'
import { SelectField, TextAreaField, TextField, type Choice } from '../crm/fields'
import { FormMessage, SubmitButton } from '../form-bits'

type Schedule = {
  id: string
  name: string
  currency: string
  taxMode: string
  paymentTermsDays: number
  intervalUnit: string
  intervalCount: number
  startOn: string
  endOn: string | null
  maxOccurrences: number | null
  notes: string | null
  ownerId: string | null
}

const choices = (items: Choice[]) => items.map((i) => ({ value: i.id, label: i.name }))

function Calendar({ state, schedule }: { state: ActionState<unknown>; schedule?: Schedule }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField state={state} name="intervalCount" label="Every" type="number" defaultValue={String(schedule?.intervalCount ?? 1)} />
      <SelectField state={state} name="intervalUnit" label="Unit" defaultValue={schedule?.intervalUnit ?? 'month'} options={options(BILLING_INTERVAL_LABELS)} />
      <TextField
        state={state}
        name="startOn"
        label="First period starts"
        type="date"
        hint="Every later period is measured from this day, so the 31st stays the 31st."
        defaultValue={schedule?.startOn}
      />
      <TextField state={state} name="endOn" label="Stop after" type="date" defaultValue={schedule?.endOn ?? ''} />
      <TextField
        state={state}
        name="maxOccurrences"
        label="Or after this many invoices"
        type="number"
        defaultValue={schedule?.maxOccurrences?.toString() ?? ''}
      />
      <TextField state={state} name="paymentTermsDays" label="Payment terms (days)" type="number" defaultValue={String(schedule?.paymentTermsDays ?? 14)} />
    </div>
  )
}

export function CreateScheduleForm({
  companies,
  taxRates,
  baseCurrency,
  today,
  companyId,
}: {
  companies: Choice[]
  taxRates: Choice[]
  baseCurrency: string
  today: string
  companyId?: string | undefined
}) {
  const [state, action] = useActionState(createScheduleAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField state={state} name="companyId" label="Client" defaultValue={companyId} options={choices(companies)} empty="Choose a client" />
        <TextField state={state} name="name" label="Name" required placeholder="Website care plan" hint="Each invoice it raises is titled this." />
        <TextField state={state} name="currency" label="Currency" defaultValue={baseCurrency} />
        <SelectField state={state} name="taxMode" label="Tax" defaultValue="exclusive" options={options(TAX_MODE_LABELS)} />
      </div>
      <Calendar state={state} schedule={{ startOn: today } as Schedule} />
      <fieldset className="space-y-4 rounded-lg border border-line p-4">
        <legend className="px-1 text-sm font-medium text-ink">What each period bills</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-1">
            <TextField state={state} name="lineDescription" label="Description" required placeholder="Care plan" />
          </div>
          <TextField state={state} name="lineAmount" label="Amount" required placeholder="500.00" />
          <SelectField state={state} name="lineTaxRateId" label="Tax" options={choices(taxRates)} empty="No tax" />
        </div>
        <p className="text-xs text-muted">More lines can be added once the schedule exists.</p>
      </fieldset>
      <TextAreaField state={state} name="notes" label="Notes on the invoice" />
      <SubmitButton pendingLabel="Creating…">Create schedule</SubmitButton>
    </form>
  )
}

export function EditScheduleForm({ schedule, members }: { schedule: Schedule; members: Choice[] }) {
  const [state, action] = useActionState(updateScheduleAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="id" value={schedule.id} />
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="name" label="Name" defaultValue={schedule.name} required />
        <SelectField state={state} name="taxMode" label="Tax" defaultValue={schedule.taxMode} options={options(TAX_MODE_LABELS)} />
        <SelectField state={state} name="ownerId" label="Owner" defaultValue={schedule.ownerId} options={choices(members)} empty="Unassigned" />
      </div>
      <Calendar state={state} schedule={schedule} />
      <TextAreaField state={state} name="notes" label="Notes on the invoice" defaultValue={schedule.notes} />
      <SubmitButton pendingLabel="Saving…">Save schedule</SubmitButton>
    </form>
  )
}

export function AddScheduleLineForm({ scheduleId, currency, taxRates }: { scheduleId: string; currency: string; taxRates: Choice[] }) {
  const [state, action] = useActionState(addScheduleLineAction, idle)
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" noValidate>
      <input type="hidden" name="scheduleId" value={scheduleId} />
      <input type="hidden" name="currency" value={currency} />
      <div className="min-w-56 flex-1">
        <TextField state={state} name="description" label="Description" required placeholder="Extra support hours" />
      </div>
      <div className="w-28">
        <TextField state={state} name="quantity" label="Qty" defaultValue="1" />
      </div>
      <div className="w-36">
        <TextField state={state} name="unitAmount" label={`Amount (${currency})`} required placeholder="150.00" />
      </div>
      <div className="w-44">
        <SelectField state={state} name="taxRateId" label="Tax" options={choices(taxRates)} empty="No tax" />
      </div>
      <SubmitButton size="sm" pendingLabel="Adding…">Add line</SubmitButton>
      <FormMessage state={state} />
    </form>
  )
}

export function RemoveScheduleLineButton({ scheduleId, lineId }: { scheduleId: string; lineId: string }) {
  const [, action] = useActionState(removeScheduleLineAction, idle)
  return (
    <form action={action}>
      <input type="hidden" name="scheduleId" value={scheduleId} />
      <input type="hidden" name="lineId" value={lineId} />
      <SubmitButton variant="ghost" size="xs" pendingLabel="…">Remove</SubmitButton>
    </form>
  )
}

export function ScheduleStatusControl({ id, status }: { id: string; status: string }) {
  const [state, action] = useActionState(changeScheduleStatusAction, idle)
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`schedule-status-${id}`} className="sr-only">Schedule status</label>
      <Select
        id={`schedule-status-${id}`}
        name="status"
        defaultValue={status}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-8 w-32 text-[13px]"
      >
        {options(BILLING_SCHEDULE_STATUS_LABELS).map((o) => (
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

/**
 * Raises this period's draft now rather than waiting for the worker.
 *
 * `force` bills the next period before its start date -- for the case where a
 * client asks to be invoiced early.
 */
export function GenerateInvoiceButton({ id, due, force = false }: { id: string; due: boolean; force?: boolean }) {
  const [state, action] = useActionState(generateInvoiceAction, idle)
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      {force && <input type="hidden" name="force" value="1" />}
      <SubmitButton variant={due ? 'primary' : 'secondary'} size="sm" pendingLabel="Raising…">
        {force ? 'Bill the next period early' : 'Raise this period now'}
      </SubmitButton>
      {state.status === 'error' && <span role="alert" className="text-xs text-critical">{state.message}</span>}
      {state.status === 'success' && state.message && <span className="text-xs text-muted">{state.message}</span>}
    </form>
  )
}

export function DeleteScheduleButton({ id }: { id: string }) {
  const [, action] = useActionState(deleteScheduleAction, idle)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Deleting…">Delete</SubmitButton>
    </form>
  )
}
