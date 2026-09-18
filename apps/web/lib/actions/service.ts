'use server'

import {
  billingScheduleChangeStatus,
  billingScheduleCreate,
  billingScheduleDelete,
  billingScheduleGenerate,
  billingScheduleLineAdd,
  billingScheduleLineRemove,
  billingScheduleUpdate,
  documentDelete,
  documentUpdate,
  documentUpload,
  infrastructureAssetCreate,
  infrastructureAssetDelete,
  infrastructureAssetUpdate,
  maintenancePlanChangeStatus,
  maintenancePlanCreate,
  maintenancePlanDelete,
  maintenancePlanUpdate,
  maintenanceVisitCreate,
  maintenanceVisitDelete,
  ticketChangeStatus,
  ticketCreate,
  ticketDelete,
  ticketReply,
  ticketUpdate,
} from '@workloom/core/modules'
import { AmountFormatError, parseAmount } from '@workloom/core'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/**
 * Form actions for support, maintenance, infrastructure, documents, and
 * recurring billing.
 *
 * Each one reads a form, calls a procedure, and decides where to go next. No
 * rule lives here: an empty field is sent as "" and the procedure decides what
 * that means, exactly as it would for an API caller.
 */

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
const maybe = (form: FormData, name: string) => (form.has(name) ? text(form, name) : undefined)
const id = (form: FormData, name = 'id') => z.uuid().parse(form.get(name))
/** A select that may be left empty, where empty means "none". */
const optional = (form: FormData, name: string) => (form.has(name) ? text(form, name) || null : undefined)
const number = (form: FormData, name: string) => {
  const raw = text(form, name)
  return raw === '' ? null : Number(raw)
}
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

// Tickets

export async function createTicketAction(_: ActionState, form: FormData): Promise<ActionState> {
  let created: { id: string }
  try {
    created = await call(ticketCreate, {
      title: text(form, 'title'),
      body: text(form, 'body'),
      type: (text(form, 'type') || 'question') as never,
      priority: (text(form, 'priority') || 'normal') as never,
      companyId: optional(form, 'companyId'),
      contactId: optional(form, 'contactId'),
      projectId: optional(form, 'projectId'),
      assigneeId: optional(form, 'assigneeId'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/tickets')
  redirect(`/tickets/${created.id}`)
}

export async function updateTicketAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ticketId = id(form)
  try {
    await call(ticketUpdate, {
      id: ticketId,
      title: maybe(form, 'title'),
      body: maybe(form, 'body'),
      type: (maybe(form, 'type') || undefined) as never,
      priority: (maybe(form, 'priority') || undefined) as never,
      companyId: optional(form, 'companyId'),
      contactId: optional(form, 'contactId'),
      projectId: optional(form, 'projectId'),
      assigneeId: optional(form, 'assigneeId'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/tickets/${ticketId}`)
  return { status: 'success', message: 'Ticket saved.' }
}

export async function changeTicketStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ticketId = id(form)
  try {
    await call(ticketChangeStatus, { id: ticketId, status: text(form, 'status') as never })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/tickets/${ticketId}`)
  revalidatePath('/tickets')
  return { status: 'idle' }
}

export async function replyToTicketAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ticketId = id(form, 'ticketId')
  try {
    await call(ticketReply, {
      ticketId,
      body: text(form, 'body'),
      internal: checked(form, 'internal'),
      status: (text(form, 'status') || undefined) as never,
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/tickets/${ticketId}`)
  return { status: 'idle' }
}

export async function deleteTicketAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(ticketDelete, { id: id(form) })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/tickets')
  redirect('/tickets')
}

// Maintenance

const items = (form: FormData) =>
  form
    .getAll('items')
    .map((value) => String(value).trim())
    .filter(Boolean)

export async function createPlanAction(_: ActionState, form: FormData): Promise<ActionState> {
  let created: { id: string }
  try {
    created = await call(maintenancePlanCreate, {
      companyId: id(form, 'companyId'),
      name: text(form, 'name'),
      description: text(form, 'description'),
      startedOn: text(form, 'startedOn') || undefined,
      responseHours: number(form, 'responseHours'),
      resolutionHours: number(form, 'resolutionHours'),
      includedHours: text(form, 'includedHours') || null,
      billingScheduleId: optional(form, 'billingScheduleId'),
      ownerId: optional(form, 'ownerId'),
      items: items(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/maintenance')
  redirect(`/maintenance/${created.id}`)
}

export async function updatePlanAction(_: ActionState, form: FormData): Promise<ActionState> {
  const planId = id(form)
  try {
    await call(maintenancePlanUpdate, {
      id: planId,
      name: maybe(form, 'name'),
      description: maybe(form, 'description'),
      startedOn: text(form, 'startedOn') || undefined,
      responseHours: number(form, 'responseHours'),
      resolutionHours: number(form, 'resolutionHours'),
      includedHours: text(form, 'includedHours') || null,
      billingScheduleId: optional(form, 'billingScheduleId'),
      ownerId: optional(form, 'ownerId'),
      ...(form.has('items') ? { items: items(form) } : {}),
      notes: maybe(form, 'notes'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/maintenance/${planId}`)
  return { status: 'success', message: 'Plan saved.' }
}

export async function changePlanStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const planId = id(form)
  try {
    await call(maintenancePlanChangeStatus, { id: planId, status: text(form, 'status') as never })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/maintenance/${planId}`)
  revalidatePath('/maintenance')
  return { status: 'idle' }
}

export async function deletePlanAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(maintenancePlanDelete, { id: id(form) })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/maintenance')
  redirect('/maintenance')
}

export async function logVisitAction(_: ActionState, form: FormData): Promise<ActionState> {
  const planId = id(form, 'planId')
  try {
    await call(maintenanceVisitCreate, {
      planId,
      summary: text(form, 'summary'),
      kind: (text(form, 'kind') || 'other') as never,
      performedOn: text(form, 'performedOn') || undefined,
      notes: text(form, 'notes'),
      minutesSpent: number(form, 'minutesSpent'),
      performedBy: optional(form, 'performedBy'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/maintenance/${planId}`)
  return { status: 'success', message: 'Recorded.' }
}

export async function deleteVisitAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(maintenanceVisitDelete, { id: id(form) })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/maintenance/${text(form, 'planId')}`)
  return { status: 'idle' }
}

// Infrastructure

export async function createAssetAction(_: ActionState, form: FormData): Promise<ActionState> {
  const currency = text(form, 'currency')
  let created: { id: string }
  try {
    created = await call(infrastructureAssetCreate, {
      name: text(form, 'name'),
      kind: (text(form, 'kind') || 'other') as never,
      provider: text(form, 'provider'),
      url: text(form, 'url'),
      environment: (text(form, 'environment') || 'production') as never,
      companyId: optional(form, 'companyId'),
      projectId: optional(form, 'projectId'),
      expiresOn: text(form, 'expiresOn') || null,
      autoRenew: checked(form, 'autoRenew'),
      renewalCostMinor: text(form, 'renewalCost') ? amount(form, 'renewalCost', currency || 'AUD') : null,
      currency: text(form, 'renewalCost') ? currency : null,
      ownerId: optional(form, 'ownerId'),
      notes: text(form, 'notes'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/infrastructure')
  redirect(`/infrastructure/${created.id}`)
}

export async function updateAssetAction(_: ActionState, form: FormData): Promise<ActionState> {
  const assetId = id(form)
  const currency = text(form, 'currency')
  try {
    await call(infrastructureAssetUpdate, {
      id: assetId,
      name: maybe(form, 'name'),
      kind: (maybe(form, 'kind') || undefined) as never,
      status: (maybe(form, 'status') || undefined) as never,
      provider: maybe(form, 'provider'),
      url: maybe(form, 'url'),
      environment: (maybe(form, 'environment') || undefined) as never,
      companyId: optional(form, 'companyId'),
      projectId: optional(form, 'projectId'),
      expiresOn: form.has('expiresOn') ? text(form, 'expiresOn') || null : undefined,
      autoRenew: form.has('autoRenewPresent') ? checked(form, 'autoRenew') : undefined,
      renewalCostMinor: form.has('renewalCost') ? (text(form, 'renewalCost') ? amount(form, 'renewalCost', currency || 'AUD') : null) : undefined,
      currency: form.has('renewalCost') ? (text(form, 'renewalCost') ? currency : null) : undefined,
      ownerId: optional(form, 'ownerId'),
      notes: maybe(form, 'notes'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/infrastructure/${assetId}`)
  revalidatePath('/infrastructure')
  return { status: 'success', message: 'Saved.' }
}

export async function deleteAssetAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(infrastructureAssetDelete, { id: id(form) })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/infrastructure')
  redirect('/infrastructure')
}

// Documents

export async function uploadDocumentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { status: 'error', message: 'Choose a file to upload.', fieldErrors: { file: 'Choose a file.' } }
  }
  const companyId = id(form, 'companyId')
  try {
    await call(documentUpload, {
      companyId,
      file,
      title: text(form, 'title'),
      category: (text(form, 'category') || 'other') as never,
      projectId: optional(form, 'projectId'),
      clientVisible: checked(form, 'clientVisible'),
      notes: text(form, 'notes'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/companies/${companyId}`)
  // A document filed against a project shows on the project too.
  const filedAgainst = text(form, 'projectId')
  if (filedAgainst) revalidatePath(`/projects/${filedAgainst}`)
  return { status: 'success', message: 'Document filed.' }
}

export async function updateDocumentAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(documentUpdate, {
      id: id(form),
      title: maybe(form, 'title'),
      category: (maybe(form, 'category') || undefined) as never,
      clientVisible: form.has('clientVisiblePresent') ? checked(form, 'clientVisible') : undefined,
      notes: maybe(form, 'notes'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/companies/${text(form, 'companyId')}`)
  if (text(form, 'projectId')) revalidatePath(`/projects/${text(form, 'projectId')}`)
  return { status: 'success', message: 'Saved.' }
}

export async function deleteDocumentAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(documentDelete, { id: id(form) })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/companies/${text(form, 'companyId')}`)
  if (text(form, 'projectId')) revalidatePath(`/projects/${text(form, 'projectId')}`)
  return { status: 'idle' }
}

// Recurring billing

export async function createScheduleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const currency = text(form, 'currency') || 'AUD'
  let created: { id: string }
  try {
    created = await call(billingScheduleCreate, {
      companyId: id(form, 'companyId'),
      name: text(form, 'name'),
      currency,
      intervalUnit: (text(form, 'intervalUnit') || 'month') as never,
      intervalCount: Number(text(form, 'intervalCount') || '1'),
      startOn: text(form, 'startOn') || undefined,
      paymentTermsDays: text(form, 'paymentTermsDays') ? Number(text(form, 'paymentTermsDays')) : undefined,
      taxMode: (text(form, 'taxMode') || undefined) as never,
      endOn: text(form, 'endOn') || null,
      maxOccurrences: number(form, 'maxOccurrences'),
      projectId: optional(form, 'projectId'),
      contactId: optional(form, 'contactId'),
      notes: text(form, 'notes'),
      lines: [
        {
          description: text(form, 'lineDescription'),
          unitAmountMinor: amount(form, 'lineAmount', currency),
          taxRateId: optional(form, 'lineTaxRateId'),
        },
      ],
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/recurring')
  redirect(`/recurring/${created.id}`)
}

export async function updateScheduleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const scheduleId = id(form)
  try {
    await call(billingScheduleUpdate, {
      id: scheduleId,
      name: maybe(form, 'name'),
      intervalUnit: (maybe(form, 'intervalUnit') || undefined) as never,
      intervalCount: text(form, 'intervalCount') ? Number(text(form, 'intervalCount')) : undefined,
      startOn: text(form, 'startOn') || undefined,
      paymentTermsDays: text(form, 'paymentTermsDays') ? Number(text(form, 'paymentTermsDays')) : undefined,
      taxMode: (maybe(form, 'taxMode') || undefined) as never,
      endOn: form.has('endOn') ? text(form, 'endOn') || null : undefined,
      maxOccurrences: form.has('maxOccurrences') ? number(form, 'maxOccurrences') : undefined,
      notes: maybe(form, 'notes'),
      ownerId: optional(form, 'ownerId'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/recurring/${scheduleId}`)
  return { status: 'success', message: 'Schedule saved.' }
}

export async function addScheduleLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const scheduleId = id(form, 'scheduleId')
  try {
    await call(billingScheduleLineAdd, {
      scheduleId,
      description: text(form, 'description'),
      unitAmountMinor: amount(form, 'unitAmount', text(form, 'currency') || 'AUD'),
      quantity: text(form, 'quantity') || undefined,
      taxRateId: optional(form, 'taxRateId'),
      serviceId: optional(form, 'serviceId'),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/recurring/${scheduleId}`)
  return { status: 'idle' }
}

export async function removeScheduleLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const scheduleId = id(form, 'scheduleId')
  try {
    await call(billingScheduleLineRemove, { scheduleId, lineId: id(form, 'lineId') })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/recurring/${scheduleId}`)
  return { status: 'idle' }
}

export async function changeScheduleStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const scheduleId = id(form)
  try {
    await call(billingScheduleChangeStatus, { id: scheduleId, status: text(form, 'status') as never })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/recurring/${scheduleId}`)
  revalidatePath('/recurring')
  return { status: 'idle' }
}

export async function generateInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const scheduleId = id(form)
  let result: { invoiceId: string | null }
  try {
    result = await call(billingScheduleGenerate, { id: scheduleId, force: checked(form, 'force') })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/recurring/${scheduleId}`)
  if (result.invoiceId) redirect(`/invoices/${result.invoiceId}`)
  return { status: 'success', message: 'Nothing is due yet.' }
}

export async function deleteScheduleAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(billingScheduleDelete, { id: id(form) })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/recurring')
  redirect('/recurring')
}
