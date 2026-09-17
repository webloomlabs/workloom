'use client'

import { Button, Checkbox, Field, Input, Select } from '@workloom/ui'
import { useActionState, useState } from 'react'
import {
  changeLeadStatusAction,
  convertLeadAction,
  createLeadAction,
  updateLeadAction,
} from '@/lib/actions/crm'
import { idle, type ActionState } from '@/lib/actions/state'
import { LEAD_SOURCE_LABELS, LEAD_STATUS_LABELS, options } from '@/lib/crm-labels'
import { FormMessage, SubmitButton, fieldError } from '../form-bits'
import { OwnerField, SelectField, TextAreaField, TextField, type Choice } from './fields'

type Lead = {
  id: string
  contactName: string | null
  companyName: string | null
  email: string | null
  phone: string | null
  website: string | null
  source: string
  status: string
  details: string | null
  ownerId: string | null
}

function LeadFields({ state, lead, members }: { state: ActionState<unknown>; lead?: Lead; members: Choice[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField state={state} name="contactName" label="Name" defaultValue={lead?.contactName} />
      <TextField state={state} name="companyName" label="Company" defaultValue={lead?.companyName} />
      <TextField state={state} name="email" label="Email" type="email" defaultValue={lead?.email} />
      <TextField state={state} name="phone" label="Phone" defaultValue={lead?.phone} />
      <TextField state={state} name="website" label="Website" defaultValue={lead?.website} placeholder="example.com" />
      <SelectField state={state} name="source" label="Source" defaultValue={lead?.source ?? 'website'} options={options(LEAD_SOURCE_LABELS)} />
      <OwnerField state={state} members={members} defaultValue={lead ? lead.ownerId : null} />
      <div className="sm:col-span-2">
        <TextAreaField state={state} name="details" label="What they need" defaultValue={lead?.details} />
      </div>
    </div>
  )
}

export function CreateLeadForm({ members, currentUserId }: { members: Choice[]; currentUserId: string | null }) {
  const [state, action] = useActionState(createLeadAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <LeadFields
        state={state}
        members={members}
        lead={{ id: '', contactName: null, companyName: null, email: null, phone: null, website: null, source: 'website', status: 'new', details: null, ownerId: currentUserId }}
      />
      <SubmitButton pendingLabel="Adding…">Add lead</SubmitButton>
    </form>
  )
}

export function EditLeadForm({ lead, members }: { lead: Lead; members: Choice[] }) {
  const [state, action] = useActionState(updateLeadAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="id" value={lead.id} />
      <LeadFields state={state} lead={lead} members={members} />
      <SubmitButton pendingLabel="Saving…">Save lead</SubmitButton>
    </form>
  )
}

/** One button per status, with a reason box that appears for disqualifying. */
export function LeadStatusControls({ id, status }: { id: string; status: string }) {
  const [state, action] = useActionState(changeLeadStatusAction, idle)
  const [disqualifying, setDisqualifying] = useState(false)
  return (
    <div className="space-y-3">
      <FormMessage state={state} />
      <div className="flex flex-wrap gap-2">
        {(['new', 'contacted', 'qualified'] as const).map((s) => (
          <form key={s} action={action}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="status" value={s} />
            <Button type="submit" size="sm" variant={s === status ? 'primary' : 'secondary'} aria-pressed={s === status}>
              {LEAD_STATUS_LABELS[s]}
            </Button>
          </form>
        ))}
        <Button
          type="button"
          size="sm"
          variant={status === 'disqualified' ? 'primary' : 'secondary'}
          aria-pressed={status === 'disqualified'}
          onClick={() => setDisqualifying((v) => !v)}
        >
          Disqualify…
        </Button>
      </div>
      {disqualifying && (
        <form action={action} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="status" value="disqualified" />
          <label className="flex-1 space-y-1 text-sm">
            <span className="block font-medium">Reason (optional)</span>
            <Input name="reason" placeholder="No budget, wrong fit, …" />
          </label>
          <SubmitButton size="sm" variant="danger" pendingLabel="Saving…">Disqualify lead</SubmitButton>
        </form>
      )}
    </div>
  )
}

export function ConvertLeadForm({
  lead,
  companies,
  baseCurrency,
}: {
  lead: Lead
  companies: Choice[]
  baseCurrency: string
}) {
  const [state, action] = useActionState(convertLeadAction, idle)
  const [existing, setExisting] = useState('')
  const [withDeal, setWithDeal] = useState(false)

  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="id" value={lead.id} />
      <input type="hidden" name="baseCurrency" value={baseCurrency} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="companyId" label="Company" hint="Or attach the lead to a company you already have.">
          <Select id="companyId" name="companyId" value={existing} onChange={(e) => setExisting(e.target.value)}>
            <option value="">Create a new company</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </Field>
        {existing === '' && (
          <TextField state={state} name="companyName" label="New company name" defaultValue={lead.companyName ?? lead.contactName} />
        )}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox name="createContact" defaultChecked={Boolean(lead.contactName || lead.email)} />
        Add {lead.contactName ?? lead.email ?? 'the lead'} as a contact
        <span className="text-muted">(an existing contact with the same email is reused)</span>
      </label>

      <fieldset className="space-y-4 rounded-md border border-line p-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox name="createDeal" checked={withDeal} onChange={(e) => setWithDeal(e.target.checked)} />
          Open a deal
        </label>
        <p className="text-sm text-muted">
          {withDeal
            ? 'The company stays a prospect until the deal is won.'
            : 'Without a deal, the company becomes a client straight away.'}
        </p>
        {withDeal && (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField state={state} name="dealName" label="Deal name" defaultValue={lead.companyName} />
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <TextField state={state} name="value" label="Value" placeholder="12,500.00" />
              <TextField state={state} name="currency" label="Currency" defaultValue={baseCurrency} />
            </div>
            <TextField state={state} name="expectedCloseDate" label="Expected close" type="date" />
          </div>
        )}
        {fieldError(state, 'deal') && <p className="text-xs text-critical">{fieldError(state, 'deal')}</p>}
      </fieldset>

      <SubmitButton pendingLabel="Converting…">Convert lead</SubmitButton>
    </form>
  )
}

