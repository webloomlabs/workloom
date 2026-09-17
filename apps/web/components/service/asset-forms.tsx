'use client'

import { Checkbox, Label } from '@workloom/ui'
import { useActionState } from 'react'
import { createAssetAction, deleteAssetAction, updateAssetAction } from '@/lib/actions/service'
import { idle, type ActionState } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { ASSET_ENVIRONMENT_LABELS, ASSET_KIND_LABELS, ASSET_STATUS_LABELS } from '@/lib/service-labels'
import { SelectField, TextAreaField, TextField, type Choice } from '../crm/fields'
import { FormMessage, SubmitButton } from '../form-bits'

type Asset = {
  id: string
  name: string
  kind: string
  status: string
  provider: string | null
  url: string | null
  environment: string
  companyId: string | null
  projectId: string | null
  expiresOn: string | null
  autoRenew: boolean
  renewalCostMinor: number | null
  currency: string | null
  ownerId: string | null
  notes: string | null
}

const choices = (items: Choice[]) => items.map((i) => ({ value: i.id, label: i.name }))

/** Minor units as the decimal string the form edits. */
function decimal(minor: number | null): string {
  return minor === null ? '' : (minor / 100).toFixed(2)
}

function AssetFields({
  state,
  asset,
  companies,
  projects,
  members,
  baseCurrency,
}: {
  state: ActionState<unknown>
  asset?: Asset
  companies: Choice[]
  projects: Choice[]
  members: Choice[]
  baseCurrency: string
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="name" label="Name" defaultValue={asset?.name} required placeholder="example.com" />
        <SelectField state={state} name="kind" label="Kind" defaultValue={asset?.kind ?? 'domain'} options={options(ASSET_KIND_LABELS)} />
        <TextField state={state} name="provider" label="Provider" defaultValue={asset?.provider} placeholder="Cloudflare" />
        <TextField state={state} name="url" label="Address" defaultValue={asset?.url} placeholder="https://example.com" />
        <SelectField
          state={state}
          name="companyId"
          label="Client"
          defaultValue={asset?.companyId}
          options={choices(companies)}
          empty="The agency's own"
        />
        <SelectField state={state} name="projectId" label="Project" defaultValue={asset?.projectId} options={choices(projects)} empty="None" />
        <SelectField
          state={state}
          name="environment"
          label="Environment"
          defaultValue={asset?.environment ?? 'production'}
          options={options(ASSET_ENVIRONMENT_LABELS)}
        />
        {asset && <SelectField state={state} name="status" label="Status" defaultValue={asset.status} options={options(ASSET_STATUS_LABELS)} />}
        <TextField
          state={state}
          name="expiresOn"
          label="Renews or expires"
          type="date"
          hint="What this module is for: the worker announces this date as it approaches."
          defaultValue={asset?.expiresOn ?? ''}
        />
        <SelectField state={state} name="ownerId" label="Looked after by" defaultValue={asset?.ownerId} options={choices(members)} empty="Unassigned" />
        <TextField
          state={state}
          name="renewalCost"
          label="Renewal cost"
          defaultValue={decimal(asset?.renewalCostMinor ?? null)}
          placeholder="25.00"
        />
        <TextField state={state} name="currency" label="Currency" defaultValue={asset?.currency ?? baseCurrency} />
      </div>
      <div className="flex items-center gap-2">
        {/* Tells the action the checkbox was on the form at all, so an update
            that leaves it alone is not read as "unchecked". */}
        <input type="hidden" name="autoRenewPresent" value="1" />
        <Checkbox id="autoRenew" name="autoRenew" defaultChecked={asset?.autoRenew ?? false} />
        <Label htmlFor="autoRenew" className="font-normal text-muted">
          Renews itself — still announced, because a card on file expires too
        </Label>
      </div>
      <TextAreaField state={state} name="notes" label="Notes" defaultValue={asset?.notes} />
    </div>
  )
}

export function CreateAssetForm(props: { companies: Choice[]; projects: Choice[]; members: Choice[]; baseCurrency: string }) {
  const [state, action] = useActionState(createAssetAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <AssetFields state={state} {...props} />
      <SubmitButton pendingLabel="Saving…">Add to infrastructure</SubmitButton>
    </form>
  )
}

export function EditAssetForm({
  asset,
  ...props
}: {
  asset: Asset
  companies: Choice[]
  projects: Choice[]
  members: Choice[]
  baseCurrency: string
}) {
  const [state, action] = useActionState(updateAssetAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="id" value={asset.id} />
      <FormMessage state={state} />
      <AssetFields state={state} asset={asset} {...props} />
      <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
    </form>
  )
}

export function DeleteAssetButton({ id }: { id: string }) {
  const [, action] = useActionState(deleteAssetAction, idle)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Deleting…">Delete</SubmitButton>
    </form>
  )
}
