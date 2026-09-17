'use client'

import { Button, Checkbox, Select, Textarea } from '@workloom/ui'
import { useActionState } from 'react'
import {
  changeTicketStatusAction,
  createTicketAction,
  deleteTicketAction,
  replyToTicketAction,
  updateTicketAction,
} from '@/lib/actions/service'
import { idle, type ActionState } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { TICKET_PRIORITY_LABELS, TICKET_STATUS_LABELS, TICKET_TYPE_LABELS } from '@/lib/service-labels'
import { SelectField, TextAreaField, TextField, type Choice } from '../crm/fields'
import { FormMessage, SubmitButton } from '../form-bits'

type Ticket = {
  id: string
  title: string
  body: string
  type: string
  priority: string
  status: string
  companyId: string | null
  contactId: string | null
  projectId: string | null
  assigneeId: string | null
}

const choices = (items: Choice[]) => items.map((i) => ({ value: i.id, label: i.name }))

function TicketFields({
  state,
  ticket,
  companies,
  projects,
  members,
}: {
  state: ActionState<unknown>
  ticket?: Ticket
  companies: Choice[]
  projects: Choice[]
  members: Choice[]
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <TextField state={state} name="title" label="Summary" defaultValue={ticket?.title} required placeholder="Contact form stopped sending" />
      </div>
      <SelectField
        state={state}
        name="companyId"
        label="Client"
        defaultValue={ticket?.companyId}
        options={choices(companies)}
        empty="Internal — no client"
      />
      <SelectField state={state} name="projectId" label="Project" defaultValue={ticket?.projectId} options={choices(projects)} empty="None" />
      <SelectField state={state} name="type" label="Type" defaultValue={ticket?.type ?? 'question'} options={options(TICKET_TYPE_LABELS)} />
      <SelectField
        state={state}
        name="priority"
        label="Priority"
        hint="Decides the response and resolution targets, unless the client's plan sets them."
        defaultValue={ticket?.priority ?? 'normal'}
        options={options(TICKET_PRIORITY_LABELS)}
      />
      <SelectField state={state} name="assigneeId" label="Assigned to" defaultValue={ticket?.assigneeId} options={choices(members)} empty="Unassigned" />
      <div className="sm:col-span-2">
        <TextAreaField state={state} name="body" label="What happened" defaultValue={ticket?.body} />
      </div>
    </div>
  )
}

export function CreateTicketForm(props: { companies: Choice[]; projects: Choice[]; members: Choice[] }) {
  const [state, action] = useActionState(createTicketAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <TicketFields state={state} {...props} />
      <SubmitButton pendingLabel="Raising…">Raise ticket</SubmitButton>
    </form>
  )
}

export function EditTicketForm({ ticket, ...props }: { ticket: Ticket; companies: Choice[]; projects: Choice[]; members: Choice[] }) {
  const [state, action] = useActionState(updateTicketAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="id" value={ticket.id} />
      <FormMessage state={state} />
      <TicketFields state={state} ticket={ticket} {...props} />
      <SubmitButton pendingLabel="Saving…">Save ticket</SubmitButton>
    </form>
  )
}

/** The status control in the ticket's header. Submits on change. */
export function TicketStatusControl({ id, status }: { id: string; status: string }) {
  const [state, action] = useActionState(changeTicketStatusAction, idle)
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`status-${id}`} className="sr-only">Status</label>
      <Select id={`status-${id}`} name="status" defaultValue={status} onChange={(e) => e.currentTarget.form?.requestSubmit()} className="h-8 w-44 text-[13px]">
        {options(TICKET_STATUS_LABELS).map((o) => (
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
 * A reply, or an internal note.
 *
 * The distinction is the only thing on this form that matters: a note is for
 * the team and never counts as the answer the client is waiting for.
 */
export function ReplyForm({ ticketId, status, canResolve }: { ticketId: string; status: string; canResolve: boolean }) {
  const [state, action] = useActionState(replyToTicketAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="ticketId" value={ticketId} />
      <FormMessage state={state} />
      <label htmlFor="reply" className="sr-only">Reply</label>
      <Textarea id="reply" name="body" rows={4} placeholder="Reply to the client, or leave a note for the team…" required />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Posting…">Post</SubmitButton>
        <label className="flex items-center gap-2 text-xs text-muted">
          <Checkbox name="internal" /> Internal note
        </label>
        {canResolve && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <span>Then set to</span>
            <Select name="status" defaultValue="" className="h-8 w-40 text-xs">
              <option value="">Leave as {TICKET_STATUS_LABELS[status] ?? status}</option>
              {options(TICKET_STATUS_LABELS)
                .filter((o) => o.value !== status)
                .map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </Select>
          </label>
        )}
      </div>
    </form>
  )
}

export function DeleteTicketButton({ id }: { id: string }) {
  const [, action] = useActionState(deleteTicketAction, idle)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Deleting…">Delete</SubmitButton>
    </form>
  )
}
