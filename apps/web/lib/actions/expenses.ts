'use server'

import { installReceiptReader } from '@workloom/ai'
import { AmountFormatError, parseAmount } from '@workloom/core'
import { readReceiptFor } from '@workloom/core/modules'
import { sniffContentType } from '@workloom/storage'
import { expenseCreateFromReceipt, expenseCategoryCreate, expenseCategoryUpdate, expenseConfirm, expenseCreate, expenseDelete, expenseReceiptDelete, expenseReceiptUpload, expenseUpdate, invoiceBillExpenses } from '@workloom/core/modules'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { requireViewer } from '../server/viewer.ts'
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
    category: text(form, 'category') || 'other',
    paymentMethod: (text(form, 'paymentMethod') || null) as never,
    paidOn: text(form, 'paidOn') || null,
    reimbursable: checked(form, 'reimbursable'),
    ...(text(form, 'incurredOn') ? { incurredOn: text(form, 'incurredOn') } : {}),
    projectId: text(form, 'projectId') || null,
    companyId: text(form, 'companyId') || null,
    taxRateId: text(form, 'taxRateId') || null,
    billable: checked(form, 'billable'),
    markupPercent: text(form, 'markupPercent') || null,
    // Blank means "not recorded", which is a real answer.
    bankAccountId: text(form, 'bankAccountId') || null,
    notes: text(form, 'notes'),
    ...(text(form, 'exchangeRate') ? { exchangeRate: text(form, 'exchangeRate') } : {}),
    amountMinor: amount(form, 'amount', currency),
  }
}

/** The files picked in a receipts input. A browser posts an empty file when none was chosen. */
const receiptFiles = (form: FormData) => form.getAll('receipts').filter((f): f is File => f instanceof File && f.size > 0)

/** The currency to read amounts in: the expense's own, else the organization's base currency. */
const currencyOf = (form: FormData) => (text(form, 'currency') || text(form, 'baseCurrency')).toUpperCase()

export async function createExpenseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const returnTo = text(form, 'returnTo')
  let created: { id: string }
  try {
    const currency = currencyOf(form)
    created = await call(expenseCreate, {
      ...fields(form, currency),
      amountIncludesTax: text(form, 'amountMode') === 'gross',
      ...(text(form, 'currency') ? { currency } : {}),
    })
  } catch (error) {
    return failed(error, form)
  }
  // The expense is recorded; a receipt that is refused is reported on its page, not lost with the form.
  const refused: string[] = []
  for (const file of receiptFiles(form)) {
    try {
      await call(expenseReceiptUpload, { expenseId: created.id, file })
    } catch {
      refused.push(file.name)
    }
  }
  revalidatePath('/expenses')
  redirect(refused.length > 0 ? `/expenses/${created.id}?refused=${encodeURIComponent(refused.join(', '))}` : returnTo || '/expenses')
}

/**
 * A receipt in, a draft expense out: read by AI first when the
 * organization has turned that on, then saved as a draft to check and confirm.
 */
export async function startFromReceiptAction(_: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get('receipt')
  if (!(file instanceof File) || file.size === 0) return { status: 'error', message: 'Choose a photo or PDF of the receipt.', fieldErrors: { receipt: 'Choose a file.' } }
  let created: { expense: { id: string } }
  try {
    const viewer = await requireViewer()
    installReceiptReader()
    const bytes = Buffer.from(await file.arrayBuffer())
    const type = sniffContentType(bytes)
    // Reading happens before the expense is saved, outside its transaction; a failure leaves a blank draft.
    const draft = type ? await readReceiptFor({ organizationId: viewer.organizationId, actor: viewer.actor, role: viewer.role as never, permissions: viewer.permissions }, { bytes, contentType: type }) : null
    created = await call(expenseCreateFromReceipt, { file, draft, note: text(form, 'note') || null })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/expenses')
  redirect(`/expenses/${created.expense.id}?fromReceipt=1`)
}

export async function confirmExpenseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const expenseId = id(form)
  try {
    await call(expenseConfirm, { id: expenseId })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/expenses')
  revalidatePath(`/expenses/${expenseId}`)
  return { status: 'success', message: 'Confirmed.' }
}

export async function uploadReceiptsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const expenseId = id(form)
  const files = receiptFiles(form)
  if (files.length === 0) return { status: 'error', message: 'Choose a photo or PDF of the receipt.' }
  const duplicates: string[] = []
  try {
    for (const file of files) {
      const stored = await call(expenseReceiptUpload, { expenseId, file })
      if (stored.duplicateOf) duplicates.push(`${file.name} is also on ${stored.duplicateOf.number ?? stored.duplicateOf.description}`)
    }
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/expenses/${expenseId}`)
  revalidatePath('/expenses')
  return duplicates.length > 0
    ? { status: 'success', message: `Attached. Check for a duplicate: ${duplicates.join('; ')}.` }
    : { status: 'success', message: files.length === 1 ? 'Receipt attached.' : `${files.length} receipts attached.` }
}

export async function deleteReceiptAction(form: FormData): Promise<void> {
  await call(expenseReceiptDelete, { id: id(form) })
  revalidatePath(`/expenses/${id(form, 'expenseId')}`)
  revalidatePath('/expenses')
}

export async function updateExpenseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const expenseId = id(form)
  try {
    await call(expenseUpdate, { id: expenseId, ...fields(form, currencyOf(form)) })
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

export async function createCategoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(expenseCategoryCreate, { name: text(form, 'name'), taxTreatment: (text(form, 'taxTreatment') || 'deductible') as never })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/settings/expense-categories')
  return { status: 'success', message: 'Category added.' }
}

export async function updateCategoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(expenseCategoryUpdate, {
      key: text(form, 'key'),
      name: text(form, 'name') || undefined,
      taxTreatment: (text(form, 'taxTreatment') || undefined) as never,
      archived: text(form, 'archived') === 'true',
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/settings/expense-categories')
  return { status: 'success', message: 'Saved.' }
}
