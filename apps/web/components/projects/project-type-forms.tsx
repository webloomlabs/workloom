'use client'

import { Button } from '@workloom/ui'
import { useActionState, useState } from 'react'
import { createProjectTypeAction, updateProjectTypeAction } from '@/lib/actions/projects'
import { idle } from '@/lib/actions/state'
import { FormMessage, SubmitButton } from '../form-bits'
import { SelectField, TextField } from '../crm/fields'
import { BUDGET_PERIOD_LABELS, PROJECT_BILLING_MODEL_LABELS, options } from './labels'

export function CreateProjectTypeForm() {
  const [state, action] = useActionState(createProjectTypeAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField state={state} id="type-name" name="name" label="New kind of work" placeholder="SEO" required />
        <SelectField state={state} id="type-model" name="defaultBillingModel" label="Paid for as" defaultValue="retainer" options={options(PROJECT_BILLING_MODEL_LABELS)} />
        <SelectField state={state} id="type-period" name="defaultBudgetPeriod" label="Budgets are for" defaultValue="month" options={options(BUDGET_PERIOD_LABELS)} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Adding…">Add</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function ProjectTypeControls({ type }: { type: { id: string; name: string; defaultBillingModel: string; defaultBudgetPeriod: string; archived: boolean } }) {
  const [state, action] = useActionState(updateProjectTypeAction, idle)
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-end gap-2">
      <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Close' : 'Edit'}
      </Button>
      {open && (
        <form action={action} className="grid w-full gap-3 text-left sm:grid-cols-4" noValidate>
          <input type="hidden" name="id" value={type.id} />
          <TextField state={state} id={`${type.id}-name`} name="name" label="Name" defaultValue={type.name} />
          <SelectField state={state} id={`${type.id}-model`} name="defaultBillingModel" label="Paid for as" defaultValue={type.defaultBillingModel} options={options(PROJECT_BILLING_MODEL_LABELS)} />
          <SelectField state={state} id={`${type.id}-period`} name="defaultBudgetPeriod" label="Budgets are for" defaultValue={type.defaultBudgetPeriod} options={options(BUDGET_PERIOD_LABELS)} />
          <SelectField
            state={state}
            id={`${type.id}-archived`}
            name="archived"
            label="In use"
            defaultValue={type.archived ? 'true' : 'false'}
            options={[{ value: 'false', label: 'Active' }, { value: 'true', label: 'Archived' }]}
          />
          <div className="flex items-center gap-3 sm:col-span-4">
            <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
            <FormMessage state={state} />
          </div>
        </form>
      )}
    </div>
  )
}
