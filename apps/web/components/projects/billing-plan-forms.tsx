'use client'

import { Button, Input, Select } from '@workloom/ui'
import { useActionState, useState } from 'react'
import {
  createStageAction,
  releaseStageAction,
  removeStageAction,
  reorderStagesAction,
  updateStageAction,
} from '@/lib/actions/projects'
import { idle, type ActionState } from '@/lib/actions/state'
import { SelectField, TextField, type Choice } from '../crm/fields'
import { FormMessage, SubmitButton } from '../form-bits'

export type StageRow = {
  id: string
  name: string
  basis: string
  /** Decimal strings; whichever the basis does not use is empty. */
  percent: string
  amount: string
  trigger: string | null
  dueOn: string | null
  milestoneId: string | null
  status: string
}

const BASES = [
  { value: 'amount', label: 'A fixed amount' },
  { value: 'percent', label: 'A share of the contract' },
]

const choices = (items: Choice[]) => items.map((i) => ({ value: i.id, label: i.name }))

/**
 * The basis decides which money field applies, so only that one is shown. Both
 * are always in the form — a hidden one would submit a stale value, and the
 * action reads whichever the basis names.
 */
function StageFields({
  state,
  stage,
  currency,
  milestones,
}: {
  state: ActionState<unknown>
  stage?: StageRow
  currency: string
  milestones: Choice[]
}) {
  const [basis, setBasis] = useState(stage?.basis ?? 'amount')
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="name" label="Stage" required defaultValue={stage?.name} placeholder="50% on acceptance" />
        <SelectField state={state} name="basis" label="Worth" defaultValue={basis} options={BASES} onChange={setBasis} />
        {basis === 'percent' ? (
          <TextField
            state={state}
            name="percent"
            label="Share of the contract (%)"
            required
            defaultValue={stage?.percent}
            placeholder="50"
            hint="Follows the contract as accepted revisions raise it."
          />
        ) : (
          <TextField state={state} name="amount" label={`Amount (${currency})`} required defaultValue={stage?.amount} placeholder="5000.00" />
        )}
        <TextField state={state} name="dueOn" label="Expected" type="date" defaultValue={stage?.dueOn ?? ''} />
        <SelectField
          state={state}
          name="milestoneId"
          label="Released by"
          defaultValue={stage?.milestoneId}
          options={choices(milestones)}
          empty="Nothing in particular"
        />
        <TextField state={state} name="trigger" label="What has to be true" defaultValue={stage?.trigger} placeholder="Designs signed off" />
      </div>
    </div>
  )
}

export function AddStageForm({ projectId, currency, milestones }: { projectId: string; currency: string; milestones: Choice[] }) {
  const [state, action] = useActionState(createStageAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="currency" value={currency} />
      <FormMessage state={state} />
      <StageFields state={state} currency={currency} milestones={milestones} />
      <SubmitButton size="sm" pendingLabel="Adding…">Add stage</SubmitButton>
    </form>
  )
}

export function EditStageForm({
  stage,
  projectId,
  currency,
  milestones,
}: {
  stage: StageRow
  projectId: string
  currency: string
  milestones: Choice[]
}) {
  const [state, action] = useActionState(updateStageAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="id" value={stage.id} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="currency" value={currency} />
      <FormMessage state={state} />
      <StageFields state={state} stage={stage} currency={currency} milestones={milestones} />
      <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
    </form>
  )
}

/**
 * Releasing shows what it will bill and what would be left, because it is the
 * step that draws money down against a contract.
 */
export function ReleaseStageForm({
  stage,
  projectId,
  amountLabel,
  remainingLabel,
  contacts,
  taxRates,
}: {
  stage: StageRow
  projectId: string
  amountLabel: string
  remainingLabel: string
  contacts: Choice[]
  taxRates: Choice[]
}) {
  const [state, action] = useActionState(releaseStageAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="id" value={stage.id} />
      <input type="hidden" name="projectId" value={projectId} />
      <FormMessage state={state} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44">
          <label className="sr-only" htmlFor={`contact-${stage.id}`}>Bill to</label>
          <Select id={`contact-${stage.id}`} name="contactId" className="h-8 text-xs">
            <option value="">No named contact</option>
            {choices(contacts).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </div>
        <div className="w-36">
          <label className="sr-only" htmlFor={`tax-${stage.id}`}>Tax rate</label>
          <Select id={`tax-${stage.id}`} name="taxRateId" className="h-8 text-xs">
            <option value="">No tax</option>
            {choices(taxRates).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </div>
        <div className="w-24">
          <label className="sr-only" htmlFor={`terms-${stage.id}`}>Payment terms in days</label>
          <Input id={`terms-${stage.id}`} name="paymentTermsDays" placeholder="Terms" className="h-8 text-xs" />
        </div>
        <SubmitButton size="sm" pendingLabel="Raising…">Bill {amountLabel}</SubmitButton>
      </div>
      <p className="text-xs text-muted">Raises a draft invoice. {remainingLabel} would remain of the contract.</p>
    </form>
  )
}

export function RemoveStageButton({ id, projectId }: { id: string; projectId: string }) {
  return (
    <form action={removeStageAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="projectId" value={projectId} />
      <Button type="submit" size="sm" variant="ghost">Remove</Button>
    </form>
  )
}

/** Moves one stage up the plan by swapping it with the one above. */
export function ReorderStagesForm({ projectId, order, label }: { projectId: string; order: string[]; label: string }) {
  const [, action] = useActionState(reorderStagesAction, idle)
  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="stageIds" value={order.join(',')} />
      <SubmitButton size="xs" variant="ghost" pendingLabel="…">{label}</SubmitButton>
    </form>
  )
}
