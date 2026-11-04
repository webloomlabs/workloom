'use server'

import { AmountFormatError, parseAmount } from '@workloom/core'
import {
  quoteAccept,
  quoteEmail,
  quoteGet,
  quoteCreate,
  quoteDecline,
  quoteDelete,
  quoteDuplicate,
  quoteLineAdd,
  quoteLineRemove,
  quoteLineUpdate,
  quoteSend,
  quoteUpdate,
  serviceArchive,
  serviceCreate,
  serviceRestore,
  serviceUpdate,
  taxRateArchive,
  taxRateCreate,
  taxRateRestore,
  taxRateUpdate,
} from '@workloom/core/modules'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/**
 * Finance form actions: read the form, call a procedure. Prices are typed in
 * the document's currency ("1,250.00") and sent as minor units; every rule and
 * every total is the procedure's.
 */

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
const maybe = (form: FormData, name: string) => (form.has(name) ? text(form, name) : undefined)
const id = (form: FormData, name = 'id') => z.uuid().parse(form.get(name))

class FieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message)
  }
}

/** Procedure fields that forms present under another name. */
const FORM_FIELDS: Record<string, string> = {
  unitAmountMinor: 'unitAmount',
  defaultPriceMinor: 'defaultPrice',
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

/** An amount in a currency, which may be negative for a credit. "" is absent. */
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

/** The billing select: "default" leaves it to the service, "" shows nothing. */
function billingChoice(form: FormData): 'one_off' | 'recurring' | null | undefined {
  if (!form.has('billingType')) return undefined
  const value = String(form.get('billingType') ?? '')
  if (value === 'default') return undefined
  return value === 'one_off' || value === 'recurring' ? value : null
}

/** A tax select: "" for none, "default" to leave it to the service, or a tax rate's id. */
function taxChoice(form: FormData): string | null | undefined {
  const value = text(form, 'taxRateId')
  if (value === 'default') return undefined
  return value === '' ? null : z.uuid().parse(value)
}

// Tax rates

export async function createTaxRateAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(taxRateCreate, { name: text(form, 'name'), rate: text(form, 'rate'), description: text(form, 'description') })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/settings/tax-rates')
  return { status: 'success', message: 'Tax rate added.' }
}

export async function updateTaxRateAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(taxRateUpdate, { id: id(form), name: maybe(form, 'name'), rate: maybe(form, 'rate'), description: maybe(form, 'description') })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/settings/tax-rates')
  return { status: 'success', message: 'Saved.' }
}

export async function setTaxRateArchivedAction(form: FormData): Promise<void> {
  await call(form.get('archived') === 'true' ? taxRateArchive : taxRateRestore, { id: id(form) })
  revalidatePath('/settings/tax-rates')
}

// Services

function serviceFields(form: FormData) {
  const currency = text(form, 'currency').toUpperCase()
  return {
    name: text(form, 'name'),
    description: text(form, 'description'),
    pricingModel: (text(form, 'pricingModel') || 'fixed') as never,
    billingType: (text(form, 'billingType') || 'one_off') as never,
    unit: text(form, 'unit'),
    currency,
    defaultPriceMinor: amount(form, 'defaultPrice', currency) ?? null,
    defaultTaxRateId: text(form, 'defaultTaxRateId') || null,
  }
}

export async function createServiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(serviceCreate, serviceFields(form))
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/settings/services')
  return { status: 'success', message: 'Service added.' }
}

export async function updateServiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(serviceUpdate, { id: id(form), ...serviceFields(form) })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/settings/services')
  return { status: 'success', message: 'Saved.' }
}

export async function setServiceArchivedAction(form: FormData): Promise<void> {
  await call(form.get('archived') === 'true' ? serviceArchive : serviceRestore, { id: id(form) })
  revalidatePath('/settings/services')
}

// Quotes

const quotePath = (quoteId: string) => `/quotes/${quoteId}`

function refreshQuote(quoteId: string) {
  revalidatePath(quotePath(quoteId))
  revalidatePath('/quotes')
}

export async function createQuoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  let created: { id: string }
  try {
    const currency = text(form, 'currency').toUpperCase()
    created = await call(quoteCreate, {
      title: text(form, 'title'),
      companyId: text(form, 'companyId') || null,
      dealId: text(form, 'dealId') || null,
      ...(currency ? { currency } : {}),
      taxMode: (text(form, 'taxMode') || 'exclusive') as never,
      ...(text(form, 'validUntil') ? { validUntil: text(form, 'validUntil') } : {}),
      projectId: text(form, 'projectId') || null,
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/quotes')
  if (text(form, 'projectId')) revalidatePath(`/projects/${text(form, 'projectId')}`)
  redirect(quotePath(created.id))
}

export async function updateQuoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const quoteId = id(form)
  try {
    const currency = text(form, 'currency')
    const discountType = text(form, 'discountType')
    const discountValue = text(form, 'discountValue')
    if (discountType !== 'none' && discountValue === '') throw new FieldError('discountValue', 'Enter the discount, or choose no discount.')
    await call(quoteUpdate, {
      id: quoteId,
      title: maybe(form, 'title'),
      contactId: form.has('contactId') ? text(form, 'contactId') || null : undefined,
      taxMode: (maybe(form, 'taxMode') || undefined) as never,
      validUntil: maybe(form, 'validUntil') || undefined,
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
  refreshQuote(quoteId)
  return { status: 'success', message: 'Saved.' }
}

export async function addQuoteLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const quoteId = id(form)
  try {
    const currency = text(form, 'currency')
    await call(quoteLineAdd, {
      id: quoteId,
      serviceId: text(form, 'serviceId') || null,
      description: text(form, 'description') || undefined,
      detail: text(form, 'detail') || null,
      billingType: billingChoice(form),
      ...(form.has('intervalUnit') && text(form, 'intervalUnit') ? { intervalUnit: text(form, 'intervalUnit') as never, intervalCount: Number(text(form, 'intervalCount') || '1') } : {}),
      quantity: text(form, 'quantity') || '1',
      unitAmountMinor: amount(form, 'unitAmount', currency, { allowNegative: true }),
      discountPercent: text(form, 'discountPercent') || null,
      taxRateId: taxChoice(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  refreshQuote(quoteId)
  return { status: 'success', message: 'Line added.' }
}

export async function updateQuoteLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const quoteId = id(form, 'documentId')
  try {
    const currency = text(form, 'currency')
    const unitAmount = amount(form, 'unitAmount', currency, { allowNegative: true })
    if (unitAmount === undefined) throw new FieldError('unitAmount', 'Enter a unit price.')
    await call(quoteLineUpdate, {
      id: id(form),
      description: text(form, 'description'),
      ...(form.has('detail') ? { detail: text(form, 'detail') || null } : {}),
      billingType: billingChoice(form),
      quantity: text(form, 'quantity'),
      unitAmountMinor: unitAmount,
      discountPercent: text(form, 'discountPercent') || null,
      taxRateId: taxChoice(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  refreshQuote(quoteId)
  return { status: 'success', message: 'Line saved.' }
}

export async function removeQuoteLineAction(form: FormData): Promise<void> {
  await call(quoteLineRemove, { id: id(form) })
  refreshQuote(id(form, 'documentId'))
}

export async function sendQuoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const quoteId = id(form)
  try {
    await call(quoteSend, { id: quoteId, ...(text(form, 'exchangeRate') ? { exchangeRate: text(form, 'exchangeRate') } : {}), email: form.get('email') === 'on' })
  } catch (error) {
    return failed(error, form)
  }
  refreshQuote(quoteId)
  revalidatePath('/', 'layout')
  return { status: 'success', message: 'Quote sent.' }
}

export async function answerQuoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const quoteId = id(form)
  try {
    if (form.get('answer') === 'accept') await call(quoteAccept, { id: quoteId })
    else await call(quoteDecline, { id: quoteId, reason: text(form, 'reason') })
  } catch (error) {
    return failed(error, form)
  }
  refreshQuote(quoteId)
  return { status: 'idle' }
}

export async function duplicateQuoteAction(form: FormData): Promise<void> {
  const copy = await call(quoteDuplicate, { id: id(form), ...(form.get('asOption') ? { asOption: true } : {}) })
  revalidatePath('/quotes')
  redirect(quotePath(copy.id))
}

export async function deleteQuoteAction(form: FormData): Promise<void> {
  await call(quoteDelete, { id: id(form) })
  revalidatePath('/quotes')
  redirect('/quotes')
}

export async function acceptQuoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const quoteId = id(form)
  let projectId: string | null = null
  try {
    const target = text(form, 'target')
    const deposit = text(form, 'deposit')
    const preset = (text(form, 'stagePreset') || 'none') as 'none' | 'deposit_balance' | 'halves'
    const quote = await call(quoteGet, { id: quoteId })
    const result = await call(quoteAccept, {
      id: quoteId,
      ...(target === 'new' ? { createProject: { name: text(form, 'projectName') || null } } : target && target !== 'none' ? { projectId: target } : {}),
      stagePreset: target === 'none' ? 'none' : preset,
      ...(preset === 'deposit_balance' && deposit
        ? deposit.endsWith('%')
          ? { depositPercent: deposit.slice(0, -1).trim() }
          : { depositAmountMinor: amount(form, 'deposit', quote.currency) }
        : {}),
    })
    projectId = result.applied.projectId
  } catch (error) {
    return failed(error, form)
  }
  refreshQuote(quoteId)
  if (projectId) {
    revalidatePath(`/projects/${projectId}`)
    redirect(`/projects/${projectId}?tab=billing`)
  }
  return { status: 'success', message: 'Accepted.' }
}

export async function emailQuoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const quoteId = id(form)
  try {
    await call(quoteEmail, { id: quoteId, ...(text(form, 'to') ? { to: text(form, 'to') } : {}) })
  } catch (error) {
    return failed(error, form)
  }
  return { status: 'success', message: 'Sent.' }
}
