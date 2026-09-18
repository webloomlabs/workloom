'use client'

import { Button, Checkbox, Input } from '@workloom/ui'
import { useActionState } from 'react'
import {
  acceptRevisionAction,
  createRevisionAction,
  declineRevisionAction,
  deleteRevisionAction,
  sendRevisionAction,
  updateRevisionAction,
  withdrawRevisionAction,
} from '@/lib/actions/projects'
import { idle, type ActionState } from '@/lib/actions/state'
import { SelectField, TextAreaField, TextField } from '../crm/fields'
import { FormMessage, SubmitButton } from '../form-bits'

export type RevisionRow = {
  id: string
  number: number
  kind: string
  title: string
  summary: string | null
  status: string
  /** A signed decimal string; empty when the caller cannot see money. */
  amount: string
  newDueDate: string | null
}

const KINDS = [
  { value: 'variation', label: 'Variation — scope and price' },
  { value: 'extension', label: 'Extension — dates only' },
]

function RevisionFields({ state, revision, currency }: { state: ActionState<unknown>; revision?: RevisionRow; currency: string }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="title" label="Title" required defaultValue={revision?.title} placeholder="Two extra template designs" />
        <SelectField state={state} name="kind" label="Kind" defaultValue={revision?.kind ?? 'variation'} options={KINDS} />
        <TextField
          state={state}
          name="amount"
          label={`Change to the price (${currency})`}
          defaultValue={revision?.amount}
          placeholder="2000.00"
          hint="Negative takes work out. Leave blank for an extension."
        />
        <TextField
          state={state}
          name="newDueDate"
          label="New due date"
          type="date"
          defaultValue={revision?.newDueDate ?? ''}
          hint="Blank leaves the project's dates alone."
        />
      </div>
      <TextAreaField state={state} name="summary" label="What changed" defaultValue={revision?.summary} />
    </div>
  )
}

export function CreateRevisionForm({ projectId, currency }: { projectId: string; currency: string }) {
  const [state, action] = useActionState(createRevisionAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="currency" value={currency} />
      <FormMessage state={state} />
      <RevisionFields state={state} currency={currency} />
      <SubmitButton size="sm" pendingLabel="Saving…">Draft revision</SubmitButton>
    </form>
  )
}

export function EditRevisionForm({ revision, projectId, currency }: { revision: RevisionRow; projectId: string; currency: string }) {
  const [state, action] = useActionState(updateRevisionAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="id" value={revision.id} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="currency" value={currency} />
      <FormMessage state={state} />
      <RevisionFields state={state} revision={revision} currency={currency} />
      <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
    </form>
  )
}

/**
 * What can be done to a revision, which depends entirely on where it is.
 *
 * A draft is edited, sent or deleted. A sent one is answered or withdrawn.
 * Anything answered is history and offers nothing.
 */
export function RevisionControls({
  revision,
  projectId,
  canSend,
  canAnswer,
  canEdit,
  canDelete,
}: {
  revision: RevisionRow
  projectId: string
  canSend: boolean
  canAnswer: boolean
  canEdit: boolean
  canDelete: boolean
}) {
  const [sendState, send] = useActionState(sendRevisionAction, idle)
  const [withdrawState, withdraw] = useActionState(withdrawRevisionAction, idle)

  if (revision.status === 'draft') {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {canSend && (
          <form action={send}>
            <input type="hidden" name="id" value={revision.id} />
            <input type="hidden" name="projectId" value={projectId} />
            <SubmitButton size="sm" variant="secondary" pendingLabel="Sending…">Send to client</SubmitButton>
          </form>
        )}
        {canDelete && (
          <form action={deleteRevisionAction}>
            <input type="hidden" name="id" value={revision.id} />
            <input type="hidden" name="projectId" value={projectId} />
            <Button type="submit" size="sm" variant="ghost">Delete</Button>
          </form>
        )}
        {sendState.status === 'error' && <span role="alert" className="text-xs text-critical">{sendState.message}</span>}
        {!canSend && !canEdit && !canDelete && <span className="text-xs text-muted">Draft</span>}
      </div>
    )
  }

  if (revision.status === 'sent') {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {canAnswer && <AcceptRevisionForm revision={revision} projectId={projectId} />}
        {canEdit && (
          <form action={withdraw}>
            <input type="hidden" name="id" value={revision.id} />
            <input type="hidden" name="projectId" value={projectId} />
            <SubmitButton size="sm" variant="ghost" pendingLabel="…">Withdraw</SubmitButton>
          </form>
        )}
        {withdrawState.status === 'error' && <span role="alert" className="text-xs text-critical">{withdrawState.message}</span>}
      </div>
    )
  }

  return null
}

/**
 * Accepting is the commercial decision, so the button says what it will do
 * before it does it, and the budget question is asked rather than assumed.
 */
export function AcceptRevisionForm({ revision, projectId }: { revision: RevisionRow; projectId: string }) {
  const [state, action] = useActionState(acceptRevisionAction, idle)
  const [declineState, decline] = useActionState(declineRevisionAction, idle)
  const priced = revision.amount !== '' && revision.amount !== '0.00'
  return (
    <div className="flex flex-wrap items-start justify-end gap-2">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={revision.id} />
        <input type="hidden" name="projectId" value={projectId} />
        {priced && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <Checkbox name="raiseBudget" />
            {/* Being paid more does not by itself mean the work may cost more. */}
            Raise the budget too
          </label>
        )}
        <SubmitButton size="sm" pendingLabel="Accepting…">Accept</SubmitButton>
      </form>
      <form action={decline} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={revision.id} />
        <input type="hidden" name="projectId" value={projectId} />
        <label className="sr-only" htmlFor={`reason-${revision.id}`}>Why revision {revision.number} was declined</label>
        <div className="w-40">
          <Input id={`reason-${revision.id}`} name="reason" placeholder="Reason (optional)" className="h-8 text-xs" />
        </div>
        <SubmitButton size="sm" variant="ghost" pendingLabel="…">Decline</SubmitButton>
      </form>
      {(state.status === 'error' || declineState.status === 'error') && (
        <span role="alert" className="w-full text-right text-xs text-critical">
          {state.status === 'error' ? state.message : declineState.status === 'error' ? declineState.message : null}
        </span>
      )}
    </div>
  )
}
