'use client'

import { useActionState } from 'react'
import {
  createBankTransactionAction,
  deleteBankTransactionAction,
  ignoreBankTransactionAction,
  unignoreBankTransactionAction,
  updateBankTransactionAction,
} from '@/lib/actions/banking'
import { idle, type ActionState } from '@/lib/actions/state'
import { TextField, SelectField, TextAreaField } from '../crm/fields'
import { FormMessage, SubmitButton } from '../form-bits'

type Line = {
  id: string
  bankAccountId: string
  currency: string
  amountMinor: number
  bookedOn: string
  valueOn: string | null
  description: string
  counterparty: string | null
  reference: string | null
  notes: string | null
  matchedMinor: number
}

/**
 * The stored amount is signed, but nobody types a minus sign into a form. The
 * form asks for a magnitude and a direction; the action puts them back together.
 */
const DIRECTIONS = [
  { value: 'in', label: 'Money in' },
  { value: 'out', label: 'Money out' },
]

function magnitude(minor: number): string {
  return (Math.abs(minor) / 100).toFixed(2)
}

function LineFields({ state, line, today }: { state: ActionState<unknown>; line?: Line; today: string }) {
  const locked = (line?.matchedMinor ?? 0) !== 0
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          state={state}
          name="bookedOn"
          label="Date"
          type="date"
          required
          defaultValue={line?.bookedOn ?? today}
          disabled={locked}
          hint="The day the bank posted it, which is the day it counts."
        />
        <SelectField
          state={state}
          name="direction"
          label="Direction"
          defaultValue={line && line.amountMinor < 0 ? 'out' : 'in'}
          options={DIRECTIONS}
          disabled={locked}
        />
        <TextField
          state={state}
          name="amount"
          label="Amount"
          required
          defaultValue={line ? magnitude(line.amountMinor) : ''}
          placeholder="1320.00"
          disabled={locked}
          hint={locked ? 'Locked: this line explains a payment or an expense.' : undefined}
        />
        <TextField state={state} name="counterparty" label="Counterparty" defaultValue={line?.counterparty} placeholder="Acme Pty Ltd" />
        <TextField state={state} name="reference" label="Reference" defaultValue={line?.reference} placeholder="INV-0042" />
        <TextField state={state} name="valueOn" label="Value date" type="date" defaultValue={line?.valueOn ?? ''} />
      </div>
      <TextField
        state={state}
        name="description"
        label="Description"
        required
        defaultValue={line?.description}
        placeholder="TRANSFER FROM ACME PTY LTD"
        hint="The narration as the bank wrote it. It is what ties this row back to the paper."
      />
      <TextAreaField state={state} name="notes" label="Notes" defaultValue={line?.notes} />
    </div>
  )
}

export function CreateTransactionForm({
  bankAccountId,
  currency,
  today,
}: {
  bankAccountId: string
  currency: string
  today: string
}) {
  const [state, action] = useActionState(createBankTransactionAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <input type="hidden" name="currency" value={currency} />
      <FormMessage state={state} />
      <LineFields state={state} today={today} />
      <SubmitButton pendingLabel="Saving…">Add transaction</SubmitButton>
    </form>
  )
}

export function EditTransactionForm({ line, today }: { line: Line; today: string }) {
  const [state, action] = useActionState(updateBankTransactionAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="id" value={line.id} />
      <input type="hidden" name="bankAccountId" value={line.bankAccountId} />
      <input type="hidden" name="currency" value={line.currency} />
      <FormMessage state={state} />
      <LineFields state={state} line={line} today={today} />
      <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
    </form>
  )
}

/**
 * Setting a line aside, and putting it back.
 *
 * The reason is required, and it is required in the markup as well as in the
 * procedure: a line dismissed without one is a line nobody can audit later.
 */
export function IgnoreTransactionControl({
  id,
  bankAccountId,
  ignored,
  reason,
}: {
  id: string
  bankAccountId: string
  ignored: boolean
  reason: string | null
}) {
  const [state, action] = useActionState(ignored ? unignoreBankTransactionAction : ignoreBankTransactionAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <FormMessage state={state} />
      {ignored ? (
        <p className="text-sm text-muted">Set aside{reason ? `: ${reason}` : ''}.</p>
      ) : (
        <TextField state={state} name="reason" label="Reason" required placeholder="Bank error, reversed the next day" />
      )}
      <SubmitButton variant="secondary" size="sm" pendingLabel={ignored ? 'Restoring…' : 'Setting aside…'}>
        {ignored ? 'Put back on the list' : 'Set aside'}
      </SubmitButton>
    </form>
  )
}

export function DeleteTransactionButton({ id, bankAccountId }: { id: string; bankAccountId: string }) {
  const [, action] = useActionState(deleteBankTransactionAction, idle)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Deleting…">
        Delete
      </SubmitButton>
    </form>
  )
}
