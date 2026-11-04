'use client'

import { useActionState, useState } from 'react'
import { createBankTransferAction, deleteBankTransferAction } from '@/lib/actions/banking'
import { idle } from '@/lib/actions/state'
import { SelectField, TextAreaField, TextField } from '../crm/fields'
import { FormMessage, SubmitButton } from '../form-bits'

type Account = { id: string; name: string; currency: string }

/**
 * Money moved between two of the agency's own accounts.
 *
 * "Amount received" appears only when the accounts are in different
 * currencies: in one currency, what arrives is what left.
 */
export function TransferForm({ accounts, from, to, today }: { accounts: Account[]; from?: string | undefined; to?: string | undefined; today: string }) {
  const [state, action] = useActionState(createBankTransferAction, idle)
  const first = from && accounts.some((a) => a.id === from) ? from : accounts[0]?.id
  const second = to && to !== first && accounts.some((a) => a.id === to) ? to : accounts.find((a) => a.id !== first)?.id
  const [fromId, setFromId] = useState(first ?? '')
  const [toId, setToId] = useState(second ?? '')
  const fromAccount = accounts.find((a) => a.id === fromId)
  const toAccount = accounts.find((a) => a.id === toId)
  const crossCurrency = Boolean(fromAccount && toAccount && fromAccount.currency !== toAccount.currency)
  const choices = accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }))

  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="fromCurrency" value={fromAccount?.currency ?? ''} />
      <input type="hidden" name="toCurrency" value={toAccount?.currency ?? ''} />
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField state={state} name="fromAccountId" label="From" defaultValue={fromId} options={choices} onChange={setFromId} />
        <SelectField state={state} name="toAccountId" label="To" defaultValue={toId} options={choices} onChange={setToId} />
        <TextField state={state} name="bookedOn" label="Date" type="date" required defaultValue={today} />
        <TextField
          state={state}
          name="amount"
          label={crossCurrency ? `Amount sent (${fromAccount?.currency})` : 'Amount'}
          required
          placeholder="500.00"
        />
        {crossCurrency && (
          <TextField
            state={state}
            name="received"
            label={`Amount received (${toAccount?.currency})`}
            required
            placeholder="0.00"
            hint="What arrived after conversion and fees, as the receiving bank shows it."
          />
        )}
        <TextField state={state} name="reference" label="Reference" placeholder="Monthly savings" />
      </div>
      <TextAreaField state={state} name="notes" label="Notes" />
      <SubmitButton pendingLabel="Saving…">Record transfer</SubmitButton>
    </form>
  )
}

export function DeleteTransferButton({ id, bankAccountId }: { id: string; bankAccountId: string }) {
  const [state, action] = useActionState(deleteBankTransferAction, idle)
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <FormMessage state={state} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Deleting…">
        Delete transfer
      </SubmitButton>
    </form>
  )
}
