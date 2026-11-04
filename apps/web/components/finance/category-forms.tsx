'use client'

import { Button } from '@workloom/ui'
import { useActionState, useState } from 'react'
import { createCategoryAction, updateCategoryAction } from '@/lib/actions/expenses'
import { idle } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { EXPENSE_TAX_TREATMENT_LABELS } from '@/lib/finance-labels'
import { FormMessage, SubmitButton } from '../form-bits'
import { SelectField, TextField } from '../crm/fields'

export function CreateCategoryForm() {
  const [state, action] = useActionState(createCategoryAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField state={state} id="category-name" name="name" label="New category" placeholder="Meta ads" required />
        <SelectField state={state} id="category-taxTreatment" name="taxTreatment" label="In the tax pack" defaultValue="deductible" options={options(EXPENSE_TAX_TREATMENT_LABELS)} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Adding…">Add category</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function CategoryControls({ category }: { category: { key: string; name: string; taxTreatment: string; archived: boolean } }) {
  const [state, action] = useActionState(updateCategoryAction, idle)
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-end gap-2">
      <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Close' : 'Edit'}
      </Button>
      {open && (
        <form action={action} className="grid w-full gap-3 text-left sm:grid-cols-3" noValidate>
          <input type="hidden" name="key" value={category.key} />
          <TextField state={state} id={`${category.key}-name`} name="name" label="Name" defaultValue={category.name} />
          <SelectField state={state} id={`${category.key}-tax`} name="taxTreatment" label="In the tax pack" defaultValue={category.taxTreatment} options={options(EXPENSE_TAX_TREATMENT_LABELS)} />
          <SelectField
            state={state}
            id={`${category.key}-archived`}
            name="archived"
            label="In use"
            defaultValue={category.archived ? 'true' : 'false'}
            options={[{ value: 'false', label: 'Active' }, { value: 'true', label: 'Archived' }]}
          />
          <div className="flex items-center gap-3 sm:col-span-3">
            <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
            <FormMessage state={state} />
          </div>
        </form>
      )}
    </div>
  )
}
