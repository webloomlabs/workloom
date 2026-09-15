import { and, desc, eq, ilike, isNull, lt, or, schema, sql } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import {
  companyOutput,
  insertCompany,
  loadCompany,
  makeClient,
  presentCompany,
  type Company,
} from './companies.ts'
import { contactOutput, getContact, insertContact, loadContact, type Contact } from './contacts.ts'
import { dealOutput, insertDeal, type Deal } from './deals.ts'
import {
  actingUserId,
  assertMember,
  baseCurrency,
  contains,
  currencyCode,
  minorAmount,
  optionalEmail,
  optionalText,
  optionalWebsite,
  pageInput,
  pageOutput,
  paginate,
  provided,
  queryFlag,
  refuseArchived,
  searchInput,
} from './shared.ts'

type LeadStatus = (typeof schema.LEAD_STATUSES)[number]
/** Statuses a person can set. `converted` is reached only by converting. */
export const WORKABLE_LEAD_STATUSES = ['new', 'contacted', 'qualified', 'disqualified'] as const

export const leadOutput = z.object({
  id: z.uuid(),
  contactName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  companyName: z.string().nullable(),
  website: z.string().nullable(),
  source: z.enum(schema.LEAD_SOURCES),
  status: z.enum(schema.LEAD_STATUSES),
  details: z.string().nullable(),
  disqualifiedReason: z.string().nullable(),
  ownerId: z.uuid().nullable(),
  lastActivityAt: z.date().nullable(),
  convertedAt: z.date().nullable(),
  convertedCompanyId: z.uuid().nullable(),
  convertedContactId: z.uuid().nullable(),
  convertedDealId: z.uuid().nullable(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type Lead = z.infer<typeof leadOutput>
type LeadRow = typeof schema.leads.$inferSelect

function present(row: LeadRow): Lead {
  return {
    id: row.id,
    contactName: row.contactName,
    email: row.email,
    phone: row.phone,
    companyName: row.companyName,
    website: row.website,
    source: row.source as Lead['source'],
    status: row.status as LeadStatus,
    details: row.details,
    disqualifiedReason: row.disqualifiedReason,
    ownerId: row.ownerId,
    lastActivityAt: row.lastActivityAt,
    convertedAt: row.convertedAt,
    convertedCompanyId: row.convertedCompanyId,
    convertedContactId: row.convertedContactId,
    convertedDealId: row.convertedDealId,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function loadLead(ctx: ActorContext, id: string, options: { lock?: boolean } = {}) {
  const query = ctx.tx.select().from(schema.leads).where(eq(schema.leads.id, id)).limit(1)
  const [row] = options.lock ? await query.for('update') : await query
  if (!row) throw new NotFoundError('Lead', id)
  return row
}

/** A lead's label wherever one line has to identify it. */
export function leadLabel(lead: Pick<LeadRow, 'contactName' | 'companyName' | 'email'>): string {
  return [lead.contactName, lead.companyName].filter(Boolean).join(' · ') || lead.email || 'Lead'
}

function refuseConverted(row: LeadRow): void {
  if (row.status === 'converted') {
    throw new DomainError(
      'This lead has been converted. Work with its company, contact, or deal instead.',
      'lead_converted',
    )
  }
}

const details = {
  contactName: optionalText(200),
  email: optionalEmail,
  phone: optionalText(50),
  companyName: optionalText(200),
  website: optionalWebsite,
  details: optionalText(10_000),
  ownerId: z.uuid().nullish(),
}

export const leadList = defineProcedure({
  name: 'lead.list',
  summary: 'Leads, newest first',
  permission: 'lead:read',
  readOnly: true,
  input: z.object({
    q: searchInput,
    status: z.enum(schema.LEAD_STATUSES).optional(),
    source: z.enum(schema.LEAD_SOURCES).optional(),
    includeArchived: queryFlag,
    ...pageInput,
  }),
  output: pageOutput(leadOutput),
  http: { method: 'GET', path: '/leads' },
  async handler(ctx, input) {
    const l = schema.leads
    const rows = await ctx.tx
      .select()
      .from(l)
      .where(
        and(
          input.includeArchived ? undefined : isNull(l.archivedAt),
          input.status ? eq(l.status, input.status) : undefined,
          input.source ? eq(l.source, input.source) : undefined,
          input.q
            ? or(
                ilike(l.contactName, contains(input.q)),
                ilike(l.companyName, contains(input.q)),
                ilike(l.email, contains(input.q)),
              )
            : undefined,
          input.cursor ? lt(l.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(l.id))
      .limit(input.limit + 1)
    return paginate(rows.map(present), input.limit)
  },
})

export const leadGet = defineProcedure({
  name: 'lead.get',
  summary: 'One lead, including what it was converted into',
  permission: 'lead:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: leadOutput,
  http: { method: 'GET', path: '/leads/{id}' },
  async handler(ctx, input) {
    return present(await loadLead(ctx, input.id))
  },
})

export const leadCreate = defineProcedure({
  name: 'lead.create',
  summary: 'Capture a lead',
  permission: 'lead:create',
  input: z
    .object({ ...details, source: z.enum(schema.LEAD_SOURCES).default('other') })
    .refine((v) => v.contactName || v.companyName || v.email, {
      message: 'Give at least a name, a company, or an email address.',
      path: ['contactName'],
    }),
  output: leadOutput,
  http: { method: 'POST', path: '/leads', successStatus: 201 },
  emits: ['lead.created'],
  async handler(ctx, input) {
    const ownerId = input.ownerId === undefined ? actingUserId(ctx) : input.ownerId
    await assertMember(ctx, ownerId)
    const [row] = await ctx.tx
      .insert(schema.leads)
      .values({ ...input, ownerId, id: newId(), organizationId: ctx.organizationId, createdBy: actingUserId(ctx) })
      .returning()
    const lead = present(row!)
    await ctx.audit({ action: 'lead.created', entityType: 'lead', entityId: lead.id, entityLabel: leadLabel(lead) })
    await ctx.emit('lead.created', lead)
    return lead
  },
})

export const leadUpdate = defineProcedure({
  name: 'lead.update',
  summary: "Change a lead's details. Use the status endpoint to move it along.",
  permission: 'lead:update',
  input: z.object({ id: z.uuid(), ...details, source: z.enum(schema.LEAD_SOURCES).optional() }),
  output: leadOutput,
  http: { method: 'PATCH', path: '/leads/{id}' },
  emits: ['lead.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadLead(ctx, id, { lock: true })
    refuseConverted(before)
    const patch = provided(fields)
    if (patch.ownerId) await assertMember(ctx, patch.ownerId)

    const changes = diff(before as Record<string, unknown>, patch)
    if (!changes) return present(before)

    const merged = { ...before, ...patch }
    if (!merged.contactName && !merged.companyName && !merged.email) {
      throw new DomainError('Give at least a name, a company, or an email address.', 'unidentifiable', 'contactName')
    }

    const [after] = await ctx.tx
      .update(schema.leads)
      .set({ ...patch, updatedAt: ctx.now })
      .where(eq(schema.leads.id, id))
      .returning()
    const lead = present(after!)
    await ctx.audit({ action: 'lead.updated', entityType: 'lead', entityId: id, entityLabel: leadLabel(lead), changes })
    await ctx.emit('lead.updated', lead)
    return lead
  },
})

export const leadChangeStatus = defineProcedure({
  name: 'lead.changeStatus',
  summary: 'Move a lead to new, contacted, qualified, or disqualified',
  permission: 'lead:update',
  input: z
    .object({
      id: z.uuid(),
      status: z.enum(WORKABLE_LEAD_STATUSES),
      /** Why it was disqualified. Only accepted with `disqualified`. */
      reason: optionalText(1000),
    })
    .refine((v) => v.status === 'disqualified' || !v.reason, {
      message: 'A reason only applies when disqualifying a lead.',
      path: ['reason'],
    }),
  output: leadOutput.extend({ previousStatus: z.enum(schema.LEAD_STATUSES) }),
  http: { method: 'POST', path: '/leads/{id}/status' },
  emits: ['lead.status_changed'],
  async handler(ctx, input) {
    const before = await loadLead(ctx, input.id, { lock: true })
    refuseConverted(before)
    refuseArchived(before, 'lead')
    const previousStatus = before.status as LeadStatus
    const reason = input.status === 'disqualified' ? (input.reason ?? null) : null
    if (previousStatus === input.status && reason === before.disqualifiedReason) {
      return { ...present(before), previousStatus }
    }

    const [after] = await ctx.tx
      .update(schema.leads)
      .set({ status: input.status, disqualifiedReason: reason, updatedAt: ctx.now })
      .where(eq(schema.leads.id, before.id))
      .returning()
    const lead = { ...present(after!), previousStatus }
    await ctx.audit({
      action: 'lead.status_changed',
      entityType: 'lead',
      entityId: lead.id,
      entityLabel: leadLabel(lead),
      changes: { status: { from: previousStatus, to: input.status } },
    })
    await ctx.emit('lead.status_changed', lead)
    return lead
  },
})

/** "Jane van Doe" -> Jane / van Doe. Falls back to the email's local part. */
function splitName(lead: LeadRow): { firstName: string; lastName: string | null } {
  const name = lead.contactName?.trim()
  if (name) {
    const [first, ...rest] = name.split(/\s+/)
    return { firstName: first!, lastName: rest.join(' ') || null }
  }
  return { firstName: lead.email!.split('@')[0]!, lastName: null }
}

export const leadConvert = defineProcedure({
  name: 'lead.convert',
  summary: 'Convert a lead into a company, a contact, and optionally a deal',
  permission: 'lead:convert',
  input: z.object({
    id: z.uuid(),
    /** Attach to an existing company instead of creating one. */
    companyId: z.uuid().optional(),
    /** Name for a new company. Defaults to the lead's company name, then its contact name. */
    companyName: optionalText(200),
    /** Attach an existing contact instead of creating or matching one. */
    contactId: z.uuid().optional(),
    /**
     * Create a contact from the lead's name and email. If a contact with the
     * same email already exists, that contact is used instead of a duplicate.
     */
    createContact: z.boolean().default(true),
    /**
     * Open a deal as part of the conversion. Without one, the company becomes
     * a client immediately; with one, it becomes a client when the deal is won.
     */
    deal: z
      .object({
        name: optionalText(200),
        valueMinor: minorAmount.default(0),
        currency: currencyCode.optional(),
        expectedCloseDate: z.iso.date().nullish(),
      })
      .nullish(),
  }),
  output: z.object({
    lead: leadOutput,
    company: companyOutput,
    contact: contactOutput.nullable(),
    deal: dealOutput.nullable(),
  }),
  http: { method: 'POST', path: '/leads/{id}/convert' },
  emits: ['lead.converted', 'company.created', 'company.became_client', 'contact.created', 'deal.created'],
  async handler(ctx, input) {
    // Locked, so two people converting the same lead at once produce one
    // company rather than two.
    const lead = await loadLead(ctx, input.id, { lock: true })
    refuseConverted(lead)
    refuseArchived(lead, 'lead')
    if (lead.status === 'disqualified') {
      throw new DomainError('This lead is disqualified. Reopen it before converting.', 'lead_disqualified')
    }

    const ownerId = lead.ownerId ?? actingUserId(ctx)
    const withDeal = Boolean(input.deal)

    // The company.
    let company: Company
    if (input.companyId) {
      const existing = await loadCompany(ctx, input.companyId, { lock: true })
      refuseArchived(existing, 'company')
      company = withDeal ? presentCompany(existing) : await makeClient(ctx, existing)
    } else {
      ctx.require('company:create')
      const name = input.companyName ?? lead.companyName ?? lead.contactName ?? lead.email
      company = await insertCompany(ctx, {
        name: name!,
        website: lead.website,
        lifecycleStage: withDeal ? 'prospect' : 'client',
        ownerId,
      })
    }

    // The contact.
    let contact: Contact | null = null
    if (input.contactId) {
      const existing = await loadContact(ctx, input.contactId)
      refuseArchived(existing, 'contact')
      contact = await getContact(ctx, existing.id)
    } else if (input.createContact && (lead.contactName || lead.email)) {
      const [match] = lead.email
        ? await ctx.tx
            .select()
            .from(schema.contacts)
            .where(and(sql`lower(${schema.contacts.email}) = lower(${lead.email})`, isNull(schema.contacts.archivedAt)))
            .limit(1)
        : []
      if (match) {
        // An existing person with no company is attached to this one; one
        // already at another company is left where they are.
        if (!match.companyId) {
          await ctx.tx
            .update(schema.contacts)
            .set({ companyId: company.id, updatedAt: ctx.now })
            .where(eq(schema.contacts.id, match.id))
        }
        contact = await getContact(ctx, match.id)
      } else {
        ctx.require('contact:create')
        contact = await insertContact(ctx, {
          ...splitName(lead),
          email: lead.email,
          phone: lead.phone,
          companyId: company.id,
          ownerId,
        })
      }
    }

    // The deal.
    let deal: Deal | null = null
    if (input.deal) {
      ctx.require('deal:create')
      deal = await insertDeal(ctx, {
        companyId: company.id,
        contactId: contact?.id ?? null,
        name: input.deal.name ?? company.name,
        valueMinor: input.deal.valueMinor,
        currency: input.deal.currency ?? (await baseCurrency(ctx)),
        expectedCloseDate: input.deal.expectedCloseDate ?? null,
        ownerId,
      })
    }

    const [after] = await ctx.tx
      .update(schema.leads)
      .set({
        status: 'converted',
        convertedAt: ctx.now,
        convertedCompanyId: company.id,
        convertedContactId: contact?.id ?? null,
        convertedDealId: deal?.id ?? null,
        updatedAt: ctx.now,
      })
      .where(eq(schema.leads.id, lead.id))
      .returning()

    // History moves with the relationship: everything logged against the lead
    // now also appears on the company, contact, and deal it became.
    await ctx.tx
      .update(schema.activities)
      .set({
        companyId: sql`coalesce(${schema.activities.companyId}, ${company.id}::uuid)`,
        contactId: sql`coalesce(${schema.activities.contactId}, ${contact?.id ?? null}::uuid)`,
        dealId: sql`coalesce(${schema.activities.dealId}, ${deal?.id ?? null}::uuid)`,
      })
      .where(eq(schema.activities.leadId, lead.id))
    if (lead.lastActivityAt) {
      await ctx.tx
        .update(schema.companies)
        .set({ lastActivityAt: sql`greatest(${schema.companies.lastActivityAt}, ${lead.lastActivityAt})` })
        .where(eq(schema.companies.id, company.id))
    }

    const converted = present(after!)
    await ctx.audit({
      action: 'lead.converted',
      entityType: 'lead',
      entityId: lead.id,
      entityLabel: leadLabel(lead),
      changes: { status: { from: lead.status, to: 'converted' } },
    })
    await ctx.emit('lead.converted', converted)

    return { lead: converted, company: presentCompany(await loadCompany(ctx, company.id)), contact, deal }
  },
})

export const leadArchive = defineProcedure({
  name: 'lead.archive',
  summary: 'Archive a lead. It is hidden from lists but keeps its history.',
  permission: 'lead:archive',
  input: z.object({ id: z.uuid() }),
  output: leadOutput,
  http: { method: 'DELETE', path: '/leads/{id}' },
  emits: ['lead.archived'],
  async handler(ctx, input) {
    const before = await loadLead(ctx, input.id, { lock: true })
    if (before.archivedAt) return present(before)
    const [after] = await ctx.tx
      .update(schema.leads)
      .set({ archivedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(schema.leads.id, before.id))
      .returning()
    const lead = present(after!)
    await ctx.audit({ action: 'lead.archived', entityType: 'lead', entityId: lead.id, entityLabel: leadLabel(lead) })
    await ctx.emit('lead.archived', lead)
    return lead
  },
})

export const leadRestore = defineProcedure({
  name: 'lead.restore',
  summary: 'Restore an archived lead',
  permission: 'lead:archive',
  input: z.object({ id: z.uuid() }),
  output: leadOutput,
  http: { method: 'POST', path: '/leads/{id}/restore' },
  emits: ['lead.restored'],
  async handler(ctx, input) {
    const before = await loadLead(ctx, input.id, { lock: true })
    if (!before.archivedAt) return present(before)
    const [after] = await ctx.tx
      .update(schema.leads)
      .set({ archivedAt: null, updatedAt: ctx.now })
      .where(eq(schema.leads.id, before.id))
      .returning()
    const lead = present(after!)
    await ctx.audit({ action: 'lead.restored', entityType: 'lead', entityId: lead.id, entityLabel: leadLabel(lead) })
    await ctx.emit('lead.restored', lead)
    return lead
  },
})
