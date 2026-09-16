'use server'

import { AmountFormatError, parseAmount } from '@workloom/core'
import { expenseCreate, expenseDelete, expenseUpdate, invoiceBillExpenses } from '@workloom/core/modules'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/** Expense form actions: read the form, call a procedure. */

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
const id = (form: FormData, name = 'id') => z.uuid().parse(form.get(name))
const checked = (form: FormData, name: string) => form.get(name) === 'on'

class ExpenseFieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}

function failed(error: unknown, form: FormData): ActionState<never> {
  if (error instanceof ExpenseFieldError) {
    return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors: { [error.field]: error.message } }
  }
  const values: Record<string, string> = {}
  for (const [key, value] of form) if (typeof value === 'string' && !key.startsWith('$')) values[key] = value
  const state = toActionError(error)
  if (state.status !== 'error') return state
  const fieldErrors = state.fieldErrors ? Object.fromEntries(Object.entries(state.fieldErrors).map(([k, m]) => [k === 'amountMinor' ? 'amount' : k, m])) : undefined
  return { ...state, ...(fieldErrors ? { fieldErrors } : {}), values }
}

function amount(form: FormData, name: string, currency: string): number {
  try {
    return parseAmount(text(form, name), currency)
  } catch (error) {
    if (error instanceof AmountFormatError) throw new ExpenseFieldError(name, error.message)
    throw error
  }
}

/** What the form says, in the shape the procedure takes. */
function fields(form: FormData, currency: string) {
  return {
    description: text(form, 'description'),
    supplier: text(form, 'supplier'),
    category: (text(form, 'category') || 'other') as never,
    ...(text(form, 'incurredOn') ? { incurredOn: text(form, 'incurredOn') } : {}),
    projectId: text(form, 'projectId') || null,
    companyId: text(form, 'companyId') || null,
    taxRateId: text(form, 'taxRateId') || null,
    billable: checked(form, 'billable'),
    markupPercent: text(form, 'markupPercent') || null,
    notes: text(form, 'notes'),
    ...(text(form, 'exchangeRate') ? { exchangeRate: text(form, 'exchangeRate') } : {}),
    amountMinor: amount(form, 'amount', currency),
  }
}

export async function createExpenseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const returnTo = text(form, 'returnTo')
  try {
    const currency = text(form, 'currency').toUpperCase() || 'AUD'
    await call(expenseCreate, { ...fields(form, currency), ...(text(form, 'currency') ? { currency } : {}) })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/expenses')
  redirect(returnTo || '/expenses')
}

export async function updateExpenseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const expenseId = id(form)
  try {
    await call(expenseUpdate, { id: expenseId, ...fields(form, text(form, 'currency').toUpperCase() || 'AUD') })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/expenses')
  revalidatePath(`/expenses/${expenseId}`)
  return { status: 'success', message: 'Saved.' }
}

export async function deleteExpenseAction(form: FormData): Promise<void> {
  await call(expenseDelete, { id: id(form) })
  revalidatePath('/expenses')
  redirect('/expenses')
}

export async function billExpensesAction(_: ActionState, form: FormData): Promise<ActionState> {
  const invoiceId = id(form)
  let result: { rebilled: { linesAdded: number; costMinor: number; chargedMinor: number } }
  try {
    result = await call(invoiceBillExpenses, {
      id: invoiceId,
      projectId: text(form, 'projectId') || undefined,
      from: text(form, 'from') || undefined,
      to: text(form, 'to') || undefined,
      // "default" leaves each line the tax its expense carried; "" is no tax.
      ...(text(form, 'taxRateId') === 'default' ? {} : { taxRateId: text(form, 'taxRateId') || null }),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/invoices/${invoiceId}`)
  revalidatePath('/expenses')
  const { linesAdded } = result.rebilled
  return { status: 'success', message: linesAdded === 0 ? 'No unbilled expenses to add.' : `Rebilled ${linesAdded} expenses.` }
}
