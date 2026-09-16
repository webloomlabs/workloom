'use server'

import { AmountFormatError, parseAmount } from '@workloom/core'
import {
  invoiceBillTime,
  invoiceCancel,
  invoiceCreate,
  invoiceDelete,
  invoiceEmail,
  invoiceFromQuote,
  invoiceLineAdd,
  invoiceLineRemove,
  invoiceLineUpdate,
  invoiceSend,
  invoiceUpdate,
} from '@workloom/core/modules'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/**
 * Invoice form actions. As with quotes: read the form, call a procedure. Which
 * states allow what, and every total, belong to the procedure.
 */

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
const maybe = (form: FormData, name: string) => (form.has(name) ? text(form, name) : undefined)
const id = (form: FormData, name = 'id') => z.uuid().parse(form.get(name))
const checked = (form: FormData, name: string) => form.get(name) === 'on'

class FieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message)
  }
}

const FORM_FIELDS: Record<string, string> = {
  unitAmountMinor: 'unitAmount',
  discountAmountMinor: 'discountValue',
  discountPercent: 'discountValue',
  discount: 'discountValue',
}

function failed(error: unknown, form: FormData): ActionState<never> {
  const values: Record<string, string> = {}
  for (const [key, value] of form) if (typeof value === 'string' && !key.startsWith('$')) values[key] = value
  const state =
    error instanceof FieldError
      ? { status: 'error' as const, message: 'Please correct the highlighted fields.', fieldErrors: { [error.field]: error.message } }
      : toActionError(error)
  if (state.status !== 'error') return state
  const fieldErrors = state.fieldErrors
    ? Object.fromEntries(Object.entries(state.fieldErrors).map(([key, message]) => [FORM_FIELDS[key.replace(/^lines\.\d+\./, '')] ?? key.replace(/^lines\.\d+\./, ''), message]))
    : undefined
  return { ...state, ...(fieldErrors ? { fieldErrors } : {}), values }
}

function amount(form: FormData, name: string, currency: string, options: { allowNegative?: boolean } = {}): number | undefined {
  const raw = text(form, name)
  if (raw === '') return undefined
  const negative = raw.startsWith('-')
  if (negative && !options.allowNegative) throw new FieldError(name, 'Enter an amount of zero or more.')
  try {
    const minor = parseAmount(negative ? raw.slice(1) : raw, currency)
    return negative ? -minor : minor
  } catch (error) {
    if (error instanceof AmountFormatError) throw new FieldError(name, error.message)
    throw error
  }
}

/** A tax select: "" for none, "default" to leave it to the service, or a tax rate's id. */
function taxChoice(form: FormData): string | null | undefined {
  const value = text(form, 'taxRateId')
  if (value === 'default') return undefined
  return value === '' ? null : z.uuid().parse(value)
}

const invoicePath = (invoiceId: string) => `/invoices/${invoiceId}`

function refresh(invoiceId: string) {
  revalidatePath(invoicePath(invoiceId))
  revalidatePath('/invoices')
}

export async function createInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  let created: { id: string }
  try {
    const currency = text(form, 'currency').toUpperCase()
    created = await call(invoiceCreate, {
      title: text(form, 'title'),
      companyId: text(form, 'companyId') || null,
      dealId: text(form, 'dealId') || null,
      projectId: text(form, 'projectId') || null,
      ...(currency ? { currency } : {}),
      taxMode: (text(form, 'taxMode') || 'exclusive') as never,
      ...(text(form, 'paymentTermsDays') ? { paymentTermsDays: Number(text(form, 'paymentTermsDays')) } : {}),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/invoices')
  redirect(invoicePath(created.id))
}

export async function invoiceFromQuoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  let created: { id: string }
  try {
    created = await call(invoiceFromQuote, { id: id(form) })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/invoices')
  redirect(invoicePath(created.id))
}

export async function updateInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const invoiceId = id(form)
  try {
    const currency = text(form, 'currency')
    const discountType = text(form, 'discountType')
    const discountValue = text(form, 'discountValue')
    if (discountType !== 'none' && discountValue === '') throw new FieldError('discountValue', 'Enter the discount, or choose no discount.')
    await call(invoiceUpdate, {
      id: invoiceId,
      title: maybe(form, 'title'),
      contactId: form.has('contactId') ? text(form, 'contactId') || null : undefined,
      taxMode: (maybe(form, 'taxMode') || undefined) as never,
      ...(text(form, 'paymentTermsDays') ? { paymentTermsDays: Number(text(form, 'paymentTermsDays')) } : {}),
      notes: maybe(form, 'notes'),
      terms: maybe(form, 'terms'),
      ...(form.has('newCurrency') && text(form, 'newCurrency') ? { currency: text(form, 'newCurrency').toUpperCase() } : {}),
      ...(discountType === 'percent'
        ? { discountPercent: discountValue, discountAmountMinor: null }
        : discountType === 'amount'
          ? { discountAmountMinor: amount(form, 'discountValue', currency)!, discountPercent: null }
          : { discountPercent: null, discountAmountMinor: null }),
    })
  } catch (error) {
    return failed(error, form)
  }
  refresh(invoiceId)
  return { status: 'success', message: 'Saved.' }
}

export async function addInvoiceLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const invoiceId = id(form)
  try {
    const currency = text(form, 'currency')
    await call(invoiceLineAdd, {
      id: invoiceId,
      serviceId: text(form, 'serviceId') || null,
      description: text(form, 'description') || undefined,
      quantity: text(form, 'quantity') || '1',
      unitAmountMinor: amount(form, 'unitAmount', currency, { allowNegative: true }),
      discountPercent: text(form, 'discountPercent') || null,
      taxRateId: taxChoice(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  refresh(invoiceId)
  return { status: 'success', message: 'Line added.' }
}

export async function updateInvoiceLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const invoiceId = id(form, 'documentId')
  try {
    const currency = text(form, 'currency')
    const unitAmount = amount(form, 'unitAmount', currency, { allowNegative: true })
    if (unitAmount === undefined) throw new FieldError('unitAmount', 'Enter a unit price.')
    await call(invoiceLineUpdate, {
      id: id(form),
      description: text(form, 'description'),
      quantity: text(form, 'quantity'),
      unitAmountMinor: unitAmount,
      discountPercent: text(form, 'discountPercent') || null,
      taxRateId: taxChoice(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  refresh(invoiceId)
  return { status: 'success', message: 'Line saved.' }
}

export async function removeInvoiceLineAction(form: FormData): Promise<void> {
  await call(invoiceLineRemove, { id: id(form) })
  refresh(id(form, 'documentId'))
}

export async function billTimeAction(_: ActionState, form: FormData): Promise<ActionState> {
  const invoiceId = id(form)
  let billed: { billed: { entriesBilled: number; linesAdded: number; entriesWithoutRate: number } }
  try {
    billed = await call(invoiceBillTime, {
      id: invoiceId,
      projectId: text(form, 'projectId') || undefined,
      from: text(form, 'from') || undefined,
      to: text(form, 'to') || undefined,
      groupBy: (text(form, 'groupBy') || 'task') as never,
      taxRateId: text(form, 'taxRateId') || null,
    })
  } catch (error) {
    return failed(error, form)
  }
  refresh(invoiceId)
  const { entriesBilled, linesAdded, entriesWithoutRate } = billed.billed
  const unrated = entriesWithoutRate > 0 ? ` ${entriesWithoutRate} entries have no rate and were left.` : ''
  return {
    status: 'success',
    message: entriesBilled === 0 ? `No unbilled time to add.${unrated}` : `Billed ${entriesBilled} entries as ${linesAdded} lines.${unrated}`,
  }
}

export async function sendInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const invoiceId = id(form)
  try {
    await call(invoiceSend, {
      id: invoiceId,
      ...(text(form, 'exchangeRate') ? { exchangeRate: text(form, 'exchangeRate') } : {}),
      email: checked(form, 'email'),
      ...(text(form, 'to') ? { to: text(form, 'to') } : {}),
    })
  } catch (error) {
    return failed(error, form)
  }
  refresh(invoiceId)
  return { status: 'success', message: 'Invoice issued.' }
}

export async function emailInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const invoiceId = id(form)
  try {
    await call(invoiceEmail, { id: invoiceId, ...(text(form, 'to') ? { to: text(form, 'to') } : {}) })
  } catch (error) {
    return failed(error, form)
  }
  refresh(invoiceId)
  return { status: 'success', message: 'Sent.' }
}

export async function cancelInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const invoiceId = id(form)
  try {
    await call(invoiceCancel, { id: invoiceId, reason: text(form, 'reason') })
  } catch (error) {
    return failed(error, form)
  }
  refresh(invoiceId)
  return { status: 'idle' }
}

export async function deleteInvoiceAction(form: FormData): Promise<void> {
  await call(invoiceDelete, { id: id(form) })
  revalidatePath('/invoices')
  redirect('/invoices')
}
