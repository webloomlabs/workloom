'use client'

import { Checkbox, Label } from '@workloom/ui'
import { useActionState } from 'react'
import {
  adjustBalanceAction,
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
  hasReconciled: boolean
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
          disabled={account?.hasReconciled}
        />
        <TextField
          state={state}
          name="openingBalance"
          label="Opening balance"
          defaultValue={account ? decimal(account.openingBalanceMinor) : ''}
          placeholder="10000.00"
          disabled={account?.hasReconciled}
          hint={
            account?.hasReconciled
              ? 'Locked: every reconciliation on this account is measured from it. Use Adjust balance instead.'
              : 'What the statement said at the end of that date. Payments and expenses after it move the balance from here. A credit card opens negative.'
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

/**
 * When the balance here and the bank's differ -- money that moved without
 * being recorded, bank charges, interest -- set it to what the bank shows. The
 * difference is added as a line, set aside with the reason given.
 */
export function AdjustBalanceForm({ accountId, currency, today }: { accountId: string; currency: string; today: string }) {
  const [state, action] = useActionState(adjustBalanceAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="id" value={accountId} />
      <input type="hidden" name="currency" value={currency} />
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField state={state} id="adjust-balance" name="balance" label={`Balance the bank shows (${currency})`} placeholder="45298.00" required />
        <TextField state={state} id="adjust-on" name="on" type="date" label="On" defaultValue={today} />
        <TextField state={state} id="adjust-reason" name="reason" label="Why they differ" placeholder="Bank charges for October" required />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="secondary" size="sm" pendingLabel="Adjusting…">Adjust balance</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
