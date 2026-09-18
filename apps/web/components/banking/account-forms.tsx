'use client'

import { Checkbox, Label } from '@workloom/ui'
import { useActionState } from 'react'
import {
  archiveBankAccountAction,
  createBankAccountAction,
  restoreBankAccountAction,
  updateBankAccountAction,
} from '@/lib/actions/banking'
import { idle, type ActionState } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { BANK_ACCOUNT_KIND_LABELS } from '@/lib/banking-labels'
import { TextField, SelectField } from '../crm/fields'
import { FormMessage, SubmitButton } from '../form-bits'

type Account = {
  id: string
  name: string
  kind: string
  currency: string
  institution: string | null
  accountIdentifier: string | null
  openingBalanceMinor: number
  openingBalanceOn: string
  isDefault: boolean
  hasTransactions: boolean
}

/** Minor units as the decimal string the form edits, sign and all. */
function decimal(minor: number): string {
  return (minor / 100).toFixed(2)
}

function AccountFields({ state, account, baseCurrency }: { state: ActionState<unknown>; account?: Account; baseCurrency: string }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="name" label="Name" defaultValue={account?.name} required placeholder="Everyday account" />
        <SelectField
          state={state}
          name="kind"
          label="Kind"
          defaultValue={account?.kind ?? 'bank'}
          options={options(BANK_ACCOUNT_KIND_LABELS)}
        />
        <TextField state={state} name="institution" label="Institution" defaultValue={account?.institution} placeholder="Commonwealth Bank" />
        <TextField
          state={state}
          name="accountIdentifier"
          label="Identifier"
          defaultValue={account?.accountIdentifier}
          placeholder="…6789"
          hint="Enough to recognise it on a statement. Never the full number."
        />
        {account ? (
          // Fixed for the life of the account: a second currency is a second
          // account, which is what keeps every balance a single sum.
          <TextField state={state} name="currencyDisplay" label="Currency" defaultValue={account.currency} disabled />
        ) : (
          <TextField state={state} name="currency" label="Currency" defaultValue={baseCurrency} />
        )}
        <TextField
          state={state}
          name="openingBalanceOn"
          label="Opening balance date"
          type="date"
          required
          defaultValue={account?.openingBalanceOn ?? ''}
          disabled={account?.hasTransactions}
        />
        <TextField
          state={state}
          name="openingBalance"
          label="Opening balance"
          defaultValue={account ? decimal(account.openingBalanceMinor) : ''}
          placeholder="10000.00"
          disabled={account?.hasTransactions}
          hint={
            account?.hasTransactions
              ? 'Locked: every reconciliation on this account is measured from it.'
              : 'What the statement said on that date. A credit card opens negative.'
          }
        />
      </div>
      <div className="flex items-center gap-2">
        {/* Tells the action the checkbox was on the form at all, so an update
            that leaves it alone is not read as "unchecked". */}
        <input type="hidden" name="isDefaultPresent" value="1" />
        <Checkbox id="isDefault" name="isDefault" defaultChecked={account?.isDefault ?? false} />
        <Label htmlFor="isDefault" className="font-normal text-muted">
          Offer this account first
        </Label>
      </div>
    </div>
  )
}

export function CreateAccountForm({ baseCurrency }: { baseCurrency: string }) {
  const [state, action] = useActionState(createBankAccountAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <AccountFields state={state} baseCurrency={baseCurrency} />
      <SubmitButton pendingLabel="Saving…">Add account</SubmitButton>
    </form>
  )
}

export function EditAccountForm({ account, baseCurrency }: { account: Account; baseCurrency: string }) {
  const [state, action] = useActionState(updateBankAccountAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="id" value={account.id} />
      <input type="hidden" name="currency" value={account.currency} />
      <FormMessage state={state} />
      <AccountFields state={state} account={account} baseCurrency={baseCurrency} />
      <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
    </form>
  )
}

/**
 * Closing an account, and reopening one. Never deleting: what went through an
 * account is the record, and a closed account still has to be reportable.
 */
export function AccountArchiveControl({ id, archived }: { id: string; archived: boolean }) {
  const [state, action] = useActionState(archived ? restoreBankAccountAction : archiveBankAccountAction, idle)
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <FormMessage state={state} />
      <SubmitButton variant="secondary" size="sm" pendingLabel={archived ? 'Reopening…' : 'Closing…'}>
        {archived ? 'Reopen account' : 'Close account'}
      </SubmitButton>
    </form>
  )
}
