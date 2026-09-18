'use server'

import {
  bankAccountArchive,
  bankAccountCreate,
  bankAccountRestore,
  bankAccountUpdate,
  bankTransactionCreate,
  bankTransactionDelete,
  bankTransactionIgnore,
  bankTransactionUnignore,
  bankTransactionUpdate,
} from '@workloom/core/modules'
import { AmountFormatError, parseAmount } from '@workloom/core'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/**
 * Form actions for bank accounts and the register.
 *
 * As elsewhere, no rule lives here: an empty field is sent as "" and the
 * procedure decides what that means, exactly as it would for an API caller.
 *
 * The one thing this file does decide is direction. A statement line's amount
 * is signed, but nobody types a minus sign into a form -- so the form asks for
 * a positive amount and a direction, and they are combined here.
 */

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
const maybe = (form: FormData, name: string) => (form.has(name) ? text(form, name) : undefined)
const id = (form: FormData, name = 'id') => z.uuid().parse(form.get(name))
const checked = (form: FormData, name: string) => form.get(name) !== null

class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}

function failed(error: unknown, form: FormData): ActionState<never> {
  const values: Record<string, string> = {}
  for (const [key, value] of form) if (typeof value === 'string' && !key.startsWith('$')) values[key] = value
  const state =
    error instanceof FieldError
      ? { status: 'error' as const, message: 'Please correct the highlighted fields.', fieldErrors: { [error.field]: error.message } }
      : toActionError(error)
  return state.status === 'error' ? { ...state, values } : state
}

/** "500.00" in the given currency, as integer minor units. */
function amount(form: FormData, name: string, currency: string): number {
  const raw = text(form, name)
  if (raw === '') return 0
  try {
    return parseAmount(raw, currency)
  } catch (error) {
    if (error instanceof AmountFormatError) throw new FieldError(name, error.message)
    throw error
  }
}

/**
 * The amount a person typed, given the direction they chose. Money out is
 * stored negative; the form never shows a minus sign.
 */
function signed(form: FormData, name: string, currency: string): number {
  const magnitude = Math.abs(amount(form, name, currency))
  return text(form, 'direction') === 'out' ? -magnitude : magnitude
}

// Accounts

export async function createBankAccountAction(_: ActionState, form: FormData): Promise<ActionState> {
  const currency = text(form, 'currency')
  let created: { id: string }
  try {
    created = await call(bankAccountCreate, {
      name: text(form, 'name'),
      kind: (text(form, 'kind') || 'bank') as never,
      currency: currency || undefined,
      institution: text(form, 'institution'),
      accountIdentifier: text(form, 'accountIdentifier'),
      openingBalanceOn: text(form, 'openingBalanceOn'),
      // Signed, and typed as such: a credit card opens negative, and writing
      // "-1200.00" is how an accountant would say that.
      openingBalanceMinor: amount(form, 'openingBalance', currency || 'AUD'),
      isDefault: checked(form, 'isDefault'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/banking')
  redirect(`/banking/${created.id}`)
}

export async function updateBankAccountAction(_: ActionState, form: FormData): Promise<ActionState> {
  const accountId = id(form)
  const currency = text(form, 'currency')
  try {
    await call(bankAccountUpdate, {
      id: accountId,
      name: maybe(form, 'name'),
      kind: (maybe(form, 'kind') || undefined) as never,
      institution: maybe(form, 'institution'),
      accountIdentifier: maybe(form, 'accountIdentifier'),
      openingBalanceOn: maybe(form, 'openingBalanceOn') || undefined,
      openingBalanceMinor: form.has('openingBalance') ? amount(form, 'openingBalance', currency || 'AUD') : undefined,
      isDefault: form.has('isDefaultPresent') ? checked(form, 'isDefault') : undefined,
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/banking/${accountId}`)
  revalidatePath('/banking')
  return { status: 'success', message: 'Saved.' }
}

export async function archiveBankAccountAction(_: ActionState, form: FormData): Promise<ActionState> {
  const accountId = id(form)
  try {
    await call(bankAccountArchive, { id: accountId })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/banking/${accountId}`)
  revalidatePath('/banking')
  return { status: 'success', message: 'Account closed.' }
}

export async function restoreBankAccountAction(_: ActionState, form: FormData): Promise<ActionState> {
  const accountId = id(form)
  try {
    await call(bankAccountRestore, { id: accountId })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/banking/${accountId}`)
  revalidatePath('/banking')
  return { status: 'success', message: 'Account reopened.' }
}

// The register

export async function createBankTransactionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const accountId = id(form, 'bankAccountId')
  const currency = text(form, 'currency') || 'AUD'
  try {
    await call(bankTransactionCreate, {
      bankAccountId: accountId,
      amountMinor: signed(form, 'amount', currency),
      bookedOn: text(form, 'bookedOn'),
      description: text(form, 'description'),
      counterparty: text(form, 'counterparty'),
      reference: text(form, 'reference'),
      valueOn: text(form, 'valueOn') || null,
      notes: text(form, 'notes'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/banking/${accountId}`)
  revalidatePath('/banking')
  redirect(`/banking/${accountId}`)
}

export async function updateBankTransactionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const lineId = id(form)
  const accountId = id(form, 'bankAccountId')
  const currency = text(form, 'currency') || 'AUD'
  try {
    await call(bankTransactionUpdate, {
      id: lineId,
      description: maybe(form, 'description'),
      amountMinor: form.has('amount') ? signed(form, 'amount', currency) : undefined,
      bookedOn: maybe(form, 'bookedOn') || undefined,
      counterparty: maybe(form, 'counterparty'),
      reference: maybe(form, 'reference'),
      valueOn: form.has('valueOn') ? text(form, 'valueOn') || null : undefined,
      notes: maybe(form, 'notes'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/banking/${accountId}`)
  revalidatePath(`/banking/transactions/${lineId}`)
  return { status: 'success', message: 'Saved.' }
}

export async function deleteBankTransactionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const accountId = id(form, 'bankAccountId')
  try {
    await call(bankTransactionDelete, { id: id(form) })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/banking/${accountId}`)
  revalidatePath('/banking')
  redirect(`/banking/${accountId}`)
}

export async function ignoreBankTransactionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const accountId = id(form, 'bankAccountId')
  try {
    await call(bankTransactionIgnore, { id: id(form), reason: text(form, 'reason') })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/banking/${accountId}`)
  revalidatePath('/banking')
  return { status: 'success', message: 'Set aside.' }
}

export async function unignoreBankTransactionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const accountId = id(form, 'bankAccountId')
  try {
    await call(bankTransactionUnignore, { id: id(form) })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/banking/${accountId}`)
  revalidatePath('/banking')
  return { status: 'success', message: 'Back on the list.' }
}
