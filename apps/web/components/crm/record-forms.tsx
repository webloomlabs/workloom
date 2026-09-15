'use client'

import { Button, Input, Select } from '@workloom/ui'
import { useActionState, useState } from 'react'
import {
  changeDealStageAction,
  createCompanyAction,
  createContactAction,
  createDealAction,
  setArchivedAction,
  updateCompanyAction,
  updateContactAction,
  updateDealAction,
} from '@/lib/actions/crm'
import { idle, type ActionState } from '@/lib/actions/state'
import { DEAL_STAGE_LABELS, LIFECYCLE_LABELS, options } from '@/lib/crm-labels'
import { FormMessage, SubmitButton } from '../form-bits'
import { choices, OwnerField, SelectField, TextAreaField, TextField, type Choice } from './fields'

// Companies

type Company = {
  id: string
  name: string
  website: string | null
  email: string | null
  phone: string | null
  industry: string | null
  address: string | null
  description: string | null
  lifecycleStage: string
  ownerId: string | null
}

function CompanyFields({ state, company, members }: { state: ActionState<unknown>; company: Partial<Company>; members: Choice[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField state={state} name="name" label="Name" required defaultValue={company.name} />
      <SelectField state={state} name="lifecycleStage" label="Stage" defaultValue={company.lifecycleStage ?? 'prospect'} options={options(LIFECYCLE_LABELS)} />
      <TextField state={state} name="website" label="Website" defaultValue={company.website} placeholder="example.com" />
      <TextField state={state} name="industry" label="Industry" defaultValue={company.industry} />
      <TextField state={state} name="email" label="Email" type="email" defaultValue={company.email} />
      <TextField state={state} name="phone" label="Phone" defaultValue={company.phone} />
      <TextField state={state} name="address" label="Address" defaultValue={company.address} />
      <OwnerField state={state} members={members} defaultValue={company.ownerId ?? null} />
      <div className="sm:col-span-2">
        <TextAreaField state={state} name="description" label="About" defaultValue={company.description} />
      </div>
    </div>
  )
}

export function CreateCompanyForm({ members, currentUserId }: { members: Choice[]; currentUserId: string | null }) {
  const [state, action] = useActionState(createCompanyAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <CompanyFields state={state} company={{ ownerId: currentUserId }} members={members} />
      <SubmitButton pendingLabel="Adding…">Add company</SubmitButton>
    </form>
  )
}

export function EditCompanyForm({ company, members }: { company: Company; members: Choice[] }) {
  const [state, action] = useActionState(updateCompanyAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="id" value={company.id} />
      <CompanyFields state={state} company={company} members={members} />
      <SubmitButton pendingLabel="Saving…">Save company</SubmitButton>
    </form>
  )
}

// Contacts

type Contact = {
  id: string
  companyId: string | null
  firstName: string
  lastName: string | null
  email: string | null
  phone: string | null
  jobTitle: string | null
  ownerId: string | null
}

function ContactFields({
  state,
  contact,
  members,
  companies,
}: {
  state: ActionState<unknown>
  contact: Partial<Contact>
  members: Choice[]
  companies?: Choice[] | undefined
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField state={state} name="firstName" label="First name" required defaultValue={contact.firstName} />
      <TextField state={state} name="lastName" label="Last name" defaultValue={contact.lastName} />
      <TextField state={state} name="email" label="Email" type="email" defaultValue={contact.email} />
      <TextField state={state} name="phone" label="Phone" defaultValue={contact.phone} />
      <TextField state={state} name="jobTitle" label="Job title" defaultValue={contact.jobTitle} />
      {companies && (
        <SelectField state={state} name="companyId" label="Company" defaultValue={contact.companyId} empty="No company" options={choices(companies)} />
      )}
      <OwnerField state={state} members={members} defaultValue={contact.ownerId ?? null} />
    </div>
  )
}

export function CreateContactForm({
  members,
  currentUserId,
  companies,
  companyId,
  returnTo,
}: {
  members: Choice[]
  currentUserId: string | null
  /** Omit when the company is fixed, as on a company's own page. */
  companies?: Choice[]
  companyId?: string
  returnTo?: string
}) {
  const [state, action] = useActionState(createContactAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      {companyId && <input type="hidden" name="companyId" value={companyId} />}
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <ContactFields state={state} contact={{ ownerId: currentUserId }} members={members} companies={companies} />
      <SubmitButton pendingLabel="Adding…">Add contact</SubmitButton>
    </form>
  )
}

export function EditContactForm({ contact, members, companies }: { contact: Contact; members: Choice[]; companies: Choice[] }) {
  const [state, action] = useActionState(updateContactAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="id" value={contact.id} />
      <ContactFields state={state} contact={contact} members={members} companies={companies} />
      <SubmitButton pendingLabel="Saving…">Save contact</SubmitButton>
    </form>
  )
}

// Deals

type Deal = {
  id: string
  name: string
  contactId: string | null
  /** Decimal string in the deal's currency, e.g. "12500.50". */
  value: string
  currency: string
  expectedCloseDate: string | null
  ownerId: string | null
}

function DealFields({
  state,
  deal,
  members,
  contacts,
}: {
  state: ActionState<unknown>
  deal: Partial<Deal>
  members: Choice[]
  contacts: Choice[]
}) {
  return (
    <>
      <TextField state={state} name="name" label="Deal name" required defaultValue={deal.name} placeholder="Website rebuild" />
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <TextField state={state} name="value" label="Value" defaultValue={deal.value} placeholder="12,500.00" />
        <TextField state={state} name="currency" label="Currency" defaultValue={deal.currency} />
      </div>
      <TextField state={state} name="expectedCloseDate" label="Expected close" type="date" defaultValue={deal.expectedCloseDate} />
      <SelectField state={state} name="contactId" label="Main contact" defaultValue={deal.contactId} empty="None" options={choices(contacts)} />
      <OwnerField state={state} members={members} defaultValue={deal.ownerId ?? null} />
    </>
  )
}

export function CreateDealForm({
  companies,
  contacts,
  members,
  currentUserId,
  companyId,
  baseCurrency,
}: {
  companies: Choice[]
  contacts: Choice[]
  members: Choice[]
  currentUserId: string | null
  companyId: string | null
  baseCurrency: string
}) {
  const [state, action] = useActionState(createDealAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField state={state} name="companyId" label="Company" defaultValue={companyId} empty="Choose a company" options={choices(companies)} />
        <SelectField
          state={state}
          name="stage"
          label="Stage"
          defaultValue="qualified"
          options={options(DEAL_STAGE_LABELS).filter((o) => o.value !== 'won' && o.value !== 'lost')}
        />
        <DealFields state={state} deal={{ currency: baseCurrency, ownerId: currentUserId }} members={members} contacts={contacts} />
      </div>
      <SubmitButton pendingLabel="Opening…">Open deal</SubmitButton>
    </form>
  )
}

export function EditDealForm({ deal, members, contacts }: { deal: Deal; members: Choice[]; contacts: Choice[] }) {
  const [state, action] = useActionState(updateDealAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="id" value={deal.id} />
      <div className="grid gap-4 sm:grid-cols-2">
        <DealFields state={state} deal={deal} members={members} contacts={contacts} />
      </div>
      <SubmitButton pendingLabel="Saving…">Save deal</SubmitButton>
    </form>
  )
}

/**
 * Moves a deal between stages. Open stages submit as soon as they are chosen;
 * "Lost" first asks why.
 */
export function DealStageControl({ id, stage, compact = false }: { id: string; stage: string; compact?: boolean }) {
  const [state, action] = useActionState(changeDealStageAction, idle)
  const [choice, setChoice] = useState(stage)
  const needsReason = choice === 'lost' && stage !== 'lost'

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label className={compact ? 'sr-only' : 'block text-sm font-medium'} htmlFor={`stage-${id}`}>Stage</label>
      <div className={compact ? 'space-y-2' : 'flex max-w-lg flex-wrap items-center gap-2'}>
        <div className={compact ? undefined : 'w-48'}>
          <Select
            id={`stage-${id}`}
            name="stage"
            value={choice}
            className={compact ? 'h-8 text-xs' : undefined}
            onChange={(e) => {
              setChoice(e.target.value)
              if (e.target.value !== 'lost') e.currentTarget.form?.requestSubmit()
            }}
          >
            {options(DEAL_STAGE_LABELS).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </div>
        {needsReason && (
          <div className={compact ? undefined : 'min-w-48 flex-1'}>
            <label className="sr-only" htmlFor={`lost-${id}`}>Why was it lost?</label>
            <Input id={`lost-${id}`} name="lostReason" placeholder="Why was it lost?" className={compact ? 'h-8 text-xs' : undefined} />
          </div>
        )}
        {/* Open stages submit on change; the button covers no-JavaScript use and "lost". */}
        {(needsReason || !compact) && (
          <SubmitButton size="sm" variant={needsReason ? 'danger' : 'secondary'} pendingLabel="Moving…">
            {needsReason ? 'Mark lost' : 'Move'}
          </SubmitButton>
        )}
      </div>
      <FormMessage state={state} />
    </form>
  )
}

// Archiving

export function ArchiveControl({
  entity,
  id,
  archived,
  label,
}: {
  entity: 'lead' | 'company' | 'contact' | 'deal'
  id: string
  archived: boolean
  label: string
}) {
  const [state, action] = useActionState(setArchivedAction, idle)
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!archived && !confirm(`Archive this ${label}? It will be hidden from lists, and can be restored.`)) e.preventDefault()
      }}
      className="space-y-2"
    >
      <input type="hidden" name="entity" value={entity} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="archived" value={String(!archived)} />
      <Button type="submit" size="sm" variant={archived ? 'secondary' : 'ghost'}>
        {archived ? `Restore ${label}` : `Archive ${label}`}
      </Button>
      <FormMessage state={state} />
    </form>
  )
}

