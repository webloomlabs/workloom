'use server'

import { AmountFormatError, parseAmount } from '@workloom/core'
import { paymentAllocate, paymentDelete, paymentRecord, paymentUnallocate, paymentUpdate } from '@workloom/core/modules'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/**
 * Payment form actions. As elsewhere: read the form, call a procedure. What an
 * invoice is then settled by, and what it reads as, belong to the procedure --
 * and under it, to the database.
 */

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
const id = (form: FormData, name = 'id') => z.uuid().parse(form.get(name))

function failed(error: unknown, form: FormData): ActionState<never> {
  const values: Record<string, string> = {}
  for (const [key, value] of form) if (typeof value === 'string' && !key.startsWith('$')) values[key] = value
  const state = toActionError(error)
  if (state.status !== 'error') return state
  // `allocations.0.amountMinor` is one field on the form.
  const fieldErrors = state.fieldErrors
    ? Object.fromEntries(Object.entries(state.fieldErrors).map(([key, message]) => [FORM_FIELDS[key] ?? key, message]))
    : undefined
  return { ...state, ...(fieldErrors ? { fieldErrors } : {}), values }
}

const FORM_FIELDS: Record<string, string> = {
  amountMinor: 'amount',
  'allocations.0.amountMinor': 'amount',
  'allocations.0.invoiceId': 'invoiceId',
  'allocation.amountMinor': 'amount',
  'allocation.invoiceId': 'invoiceId',
}

/** An amount typed as a decimal, in the currency it is being recorded in. */
function amount(form: FormData, name: string, currency: string): number {
  try {
    return parseAmount(text(form, name), currency)
  } catch (error) {
    if (error instanceof AmountFormatError) throw new PaymentFieldError(name, error.message)
    throw error
  }
}

class PaymentFieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}

function refresh(paths: Array<string | null>) {
  for (const path of paths) if (path) revalidatePath(path)
  revalidatePath('/payments')
  revalidatePath('/invoices')
}

export async function recordPaymentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const invoiceId = text(form, 'invoiceId')
  const returnTo = text(form, 'returnTo')
  try {
    const currency = text(form, 'currency').toUpperCase() || 'AUD'
    await call(paymentRecord, {
      companyId: id(form, 'companyId'),
      kind: (text(form, 'kind') || 'payment') as never,
      amountMinor: amount(form, 'amount', currency),
      ...(text(form, 'currency') ? { currency } : {}),
      ...(text(form, 'receivedOn') ? { receivedOn: text(form, 'receivedOn') } : {}),
      method: (text(form, 'method') || 'bank_transfer') as never,
      reference: text(form, 'reference'),
      notes: text(form, 'notes'),
      ...(text(form, 'exchangeRate') ? { exchangeRate: text(form, 'exchangeRate') } : {}),
      // A blank amount against a named invoice takes as much as it still owes.
      allocations: invoiceId
        ? [{ invoiceId, ...(text(form, 'allocate') ? { amountMinor: amount(form, 'allocate', currency) } : {}) }]
        : [],
    })
  } catch (error) {
    if (error instanceof PaymentFieldError) {
      return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors: { [error.field]: error.message } }
    }
    return failed(error, form)
  }
  refresh([invoiceId ? `/invoices/${invoiceId}` : null])
  if (returnTo) redirect(returnTo)
  return { status: 'success', message: 'Payment recorded.' }
}

export async function allocatePaymentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const invoiceId = id(form, 'invoiceId')
  try {
    await call(paymentAllocate, {
      id: id(form),
      invoiceId,
      ...(text(form, 'amount') ? { amountMinor: amount(form, 'amount', text(form, 'currency') || 'AUD') } : {}),
    })
  } catch (error) {
    if (error instanceof PaymentFieldError) {
      return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors: { [error.field]: error.message } }
    }
    return failed(error, form)
  }
  refresh([`/invoices/${invoiceId}`, `/payments/${id(form)}`])
  return { status: 'success', message: 'Put against the invoice.' }
}

export async function unallocatePaymentAction(form: FormData): Promise<void> {
  const invoiceId = text(form, 'invoiceId')
  const payment = await call(paymentUnallocate, { id: id(form) })
  refresh([invoiceId ? `/invoices/${invoiceId}` : null, `/payments/${payment.id}`])
}

export async function updatePaymentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const paymentId = id(form)
  try {
    const currency = text(form, 'currency').toUpperCase() || 'AUD'
    await call(paymentUpdate, {
      id: paymentId,
      ...(text(form, 'amount') ? { amountMinor: amount(form, 'amount', currency) } : {}),
      ...(text(form, 'receivedOn') ? { receivedOn: text(form, 'receivedOn') } : {}),
      ...(text(form, 'method') ? { method: text(form, 'method') as never } : {}),
      reference: text(form, 'reference'),
      notes: text(form, 'notes'),
    })
  } catch (error) {
    if (error instanceof PaymentFieldError) {
      return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors: { [error.field]: error.message } }
    }
    return failed(error, form)
  }
  refresh([`/payments/${paymentId}`])
  return { status: 'success', message: 'Saved.' }
}

export async function deletePaymentAction(form: FormData): Promise<void> {
  await call(paymentDelete, { id: id(form) })
  refresh([])
  redirect('/payments')
}
