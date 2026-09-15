'use server'

import { AmountFormatError, parseAmount } from '@workloom/core'
import {
  activityCreate,
  activityDelete,
  companyArchive,
  companyCreate,
  companyRestore,
  companyUpdate,
  contactArchive,
  contactCreate,
  contactRestore,
  contactUpdate,
  dealArchive,
  dealChangeStage,
  dealCreate,
  dealRestore,
  dealUpdate,
  leadArchive,
  leadChangeStatus,
  leadConvert,
  leadCreate,
  leadRestore,
  leadUpdate,
} from '@workloom/core/modules'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/**
 * CRM form actions.
 *
 * Each one reads a form, calls a procedure, and decides where to go next. No
 * rule lives here: an empty field is sent as "" and the procedure decides it
 * means "clear", exactly as it would for an API caller.
 */

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
/** For fields a form may omit entirely: absent means "leave unchanged". */
const maybe = (form: FormData, name: string) => (form.has(name) ? text(form, name) : undefined)
/** An owner select: "" means unassigned. */
const owner = (form: FormData) => (form.has('ownerId') ? text(form, 'ownerId') || null : undefined)
const id = (form: FormData, name = 'id') => z.uuid().parse(form.get(name))

/** "12,500.50" in the form's currency, as integer minor units. */
function amount(form: FormData, currency: string): number {
  const raw = text(form, 'value')
  if (raw === '') return 0
  try {
    return parseAmount(raw, currency)
  } catch (error) {
    if (error instanceof AmountFormatError) throw new FieldError('value', error.message)
    throw error
  }
}

class FieldError extends Error {
  constructor(readonly field: string, message: string) {
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

// Leads

export async function createLeadAction(_: ActionState, form: FormData): Promise<ActionState> {
  let created: { id: string }
  try {
    created = await call(leadCreate, {
      contactName: text(form, 'contactName'),
      companyName: text(form, 'companyName'),
      email: text(form, 'email'),
      phone: text(form, 'phone'),
      website: text(form, 'website'),
      source: z.string().parse(form.get('source') || 'other') as never,
      details: text(form, 'details'),
      ownerId: owner(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/leads')
  redirect(`/leads/${created.id}`)
}

export async function updateLeadAction(_: ActionState, form: FormData): Promise<ActionState> {
  const leadId = id(form)
  try {
    await call(leadUpdate, {
      id: leadId,
      contactName: maybe(form, 'contactName'),
      companyName: maybe(form, 'companyName'),
      email: maybe(form, 'email'),
      phone: maybe(form, 'phone'),
      website: maybe(form, 'website'),
      source: (maybe(form, 'source') || undefined) as never,
      details: maybe(form, 'details'),
      ownerId: owner(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/leads/${leadId}`)
  return { status: 'success', message: 'Lead saved.' }
}

export async function changeLeadStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const leadId = id(form)
  try {
    await call(leadChangeStatus, {
      id: leadId,
      status: text(form, 'status') as never,
      reason: text(form, 'status') === 'disqualified' ? text(form, 'reason') : undefined,
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/leads/${leadId}`)
  revalidatePath('/leads')
  return { status: 'idle' }
}

export async function convertLeadAction(_: ActionState, form: FormData): Promise<ActionState> {
  const leadId = id(form)
  let companyId: string
  try {
    const existingCompany = text(form, 'companyId')
    const currency = text(form, 'currency').toUpperCase() || undefined
    const result = await call(leadConvert, {
      id: leadId,
      ...(existingCompany ? { companyId: existingCompany } : { companyName: text(form, 'companyName') }),
      createContact: form.get('createContact') === 'on',
      deal:
        form.get('createDeal') === 'on'
          ? {
              name: text(form, 'dealName'),
              valueMinor: amount(form, currency ?? text(form, 'baseCurrency')),
              ...(currency ? { currency } : {}),
              expectedCloseDate: text(form, 'expectedCloseDate') || null,
            }
          : null,
    })
    companyId = result.company.id
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/leads')
  redirect(`/companies/${companyId}`)
}

// Companies

export async function createCompanyAction(_: ActionState, form: FormData): Promise<ActionState> {
  let created: { id: string }
  try {
    created = await call(companyCreate, {
      name: text(form, 'name'),
      website: text(form, 'website'),
      email: text(form, 'email'),
      phone: text(form, 'phone'),
      industry: text(form, 'industry'),
      address: text(form, 'address'),
      description: text(form, 'description'),
      lifecycleStage: (text(form, 'lifecycleStage') || 'prospect') as never,
      ownerId: owner(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/companies')
  redirect(`/companies/${created.id}`)
}

export async function updateCompanyAction(_: ActionState, form: FormData): Promise<ActionState> {
  const companyId = id(form)
  try {
    await call(companyUpdate, {
      id: companyId,
      name: maybe(form, 'name'),
      website: maybe(form, 'website'),
      email: maybe(form, 'email'),
      phone: maybe(form, 'phone'),
      industry: maybe(form, 'industry'),
      address: maybe(form, 'address'),
      description: maybe(form, 'description'),
      lifecycleStage: (maybe(form, 'lifecycleStage') || undefined) as never,
      ownerId: owner(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/companies/${companyId}`)
  return { status: 'success', message: 'Company saved.' }
}

// Contacts

export async function createContactAction(_: ActionState, form: FormData): Promise<ActionState> {
  let created: { id: string }
  try {
    created = await call(contactCreate, {
      firstName: text(form, 'firstName'),
      lastName: text(form, 'lastName'),
      email: text(form, 'email'),
      phone: text(form, 'phone'),
      jobTitle: text(form, 'jobTitle'),
      companyId: text(form, 'companyId') || null,
      ownerId: owner(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/contacts')
  // Added from a company page: stay there, where the new contact now appears.
  const back = text(form, 'returnTo')
  if (back.startsWith('/companies/')) {
    revalidatePath(back)
    redirect(back)
  }
  redirect(`/contacts/${created.id}`)
}

export async function updateContactAction(_: ActionState, form: FormData): Promise<ActionState> {
  const contactId = id(form)
  try {
    await call(contactUpdate, {
      id: contactId,
      firstName: maybe(form, 'firstName'),
      lastName: maybe(form, 'lastName'),
      email: maybe(form, 'email'),
      phone: maybe(form, 'phone'),
      jobTitle: maybe(form, 'jobTitle'),
      companyId: form.has('companyId') ? text(form, 'companyId') || null : undefined,
      ownerId: owner(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/contacts/${contactId}`)
  return { status: 'success', message: 'Contact saved.' }
}

// Deals

export async function createDealAction(_: ActionState, form: FormData): Promise<ActionState> {
  let created: { id: string }
  try {
    const currency = text(form, 'currency').toUpperCase()
    created = await call(dealCreate, {
      companyId: text(form, 'companyId'),
      contactId: text(form, 'contactId') || null,
      name: text(form, 'name'),
      stage: (text(form, 'stage') || 'qualified') as never,
      currency,
      valueMinor: amount(form, currency),
      expectedCloseDate: text(form, 'expectedCloseDate') || null,
      ownerId: owner(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath('/pipeline')
  redirect(`/deals/${created.id}`)
}

export async function updateDealAction(_: ActionState, form: FormData): Promise<ActionState> {
  const dealId = id(form)
  try {
    const currency = text(form, 'currency').toUpperCase()
    await call(dealUpdate, {
      id: dealId,
      name: text(form, 'name'),
      currency,
      valueMinor: amount(form, currency),
      expectedCloseDate: text(form, 'expectedCloseDate') || null,
      contactId: text(form, 'contactId') || null,
      ownerId: owner(form),
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/deals/${dealId}`)
  revalidatePath('/pipeline')
  return { status: 'success', message: 'Deal saved.' }
}

export async function changeDealStageAction(_: ActionState, form: FormData): Promise<ActionState> {
  const dealId = id(form)
  const stage = text(form, 'stage')
  try {
    await call(dealChangeStage, {
      id: dealId,
      stage: stage as never,
      lostReason: stage === 'lost' ? text(form, 'lostReason') : undefined,
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`/deals/${dealId}`)
  revalidatePath('/pipeline')
  return { status: 'idle' }
}

// Archiving, for every CRM record

const ARCHIVABLE = {
  lead: { archive: leadArchive, restore: leadRestore, path: '/leads' },
  company: { archive: companyArchive, restore: companyRestore, path: '/companies' },
  contact: { archive: contactArchive, restore: contactRestore, path: '/contacts' },
  deal: { archive: dealArchive, restore: dealRestore, path: '/deals' },
} as const

export async function setArchivedAction(_: ActionState, form: FormData): Promise<ActionState> {
  const entity = z.enum(['lead', 'company', 'contact', 'deal']).parse(form.get('entity'))
  const recordId = id(form)
  const { archive, restore, path } = ARCHIVABLE[entity]
  try {
    await call(form.get('archived') === 'true' ? archive : restore, { id: recordId } as never)
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(`${path}/${recordId}`)
  revalidatePath(entity === 'deal' ? '/pipeline' : path)
  return { status: 'idle' }
}

// Activities

export async function logActivityAction(_: ActionState, form: FormData): Promise<ActionState> {
  const target = z.enum(['companyId', 'contactId', 'leadId', 'dealId']).parse(form.get('target'))
  const targetId = id(form, 'targetId')
  const occurredAt = text(form, 'occurredAt')
  try {
    await call(activityCreate, {
      type: (text(form, 'type') || 'note') as never,
      body: text(form, 'body'),
      ...(occurredAt ? { occurredAt: new Date(occurredAt) } : {}),
      [target]: targetId,
    })
  } catch (error) {
    return failed(error, form)
  }
  revalidatePath(text(form, 'returnTo') || '/')
  return { status: 'success', message: 'Logged.' }
}

export async function deleteActivityAction(form: FormData): Promise<void> {
  await call(activityDelete, { id: id(form) })
  revalidatePath(text(form, 'returnTo') || '/')
}
