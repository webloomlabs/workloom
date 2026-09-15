import { alias, and, desc, eq, gte, ilike, isNull, lt, or, schema, sql } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany, makeClient } from './companies.ts'
import { loadContact } from './contacts.ts'
import {
  actingUserId,
  assertMember,
  baseCurrency,
  contains,
  currencyCode,
  minorAmount,
  optionalText,
  pageInput,
  pageOutput,
  paginate,
  provided,
  queryFlag,
  refuseArchived,
  requiredText,
  searchInput,
} from './shared.ts'

export const OPEN_DEAL_STAGES = ['qualified', 'proposal_sent', 'negotiation'] as const
type DealStage = (typeof schema.DEAL_STAGES)[number]

export const dealOutput = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  companyName: z.string(),
  contactId: z.uuid().nullable(),
  contactName: z.string().nullable(),
  name: z.string(),
  stage: z.enum(schema.DEAL_STAGES),
  /** Integer minor units of `currency`: 1250050 is 12,500.50 AUD. */
  valueMinor: z.number().int(),
  currency: z.string().length(3),
  expectedCloseDate: z.iso.date().nullable(),
  ownerId: z.uuid().nullable(),
  /** When it was won or lost. Null while open. */
  closedAt: z.date().nullable(),
  lostReason: z.string().nullable(),
  lastActivityAt: z.date().nullable(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type Deal = z.infer<typeof dealOutput>
type DealRow = typeof schema.deals.$inferSelect

const contactPerson = alias(schema.contacts, 'deal_contact')

function selectDeals(ctx: ActorContext) {
  return ctx.tx
    .select({
      deal: schema.deals,
      companyName: schema.companies.name,
      contactFirst: contactPerson.firstName,
      contactLast: contactPerson.lastName,
    })
    .from(schema.deals)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.deals.companyId))
    .leftJoin(contactPerson, eq(contactPerson.id, schema.deals.contactId))
}

function present(row: {
  deal: DealRow
  companyName: string
  contactFirst: string | null
  contactLast: string | null
}): Deal {
  const { deal } = row
  return {
    id: deal.id,
    companyId: deal.companyId,
    companyName: row.companyName,
    contactId: deal.contactId,
    contactName: row.contactFirst ? [row.contactFirst, row.contactLast].filter(Boolean).join(' ') : null,
    name: deal.name,
    stage: deal.stage as DealStage,
    valueMinor: deal.valueMinor,
    currency: deal.currency,
    expectedCloseDate: deal.expectedCloseDate,
    ownerId: deal.ownerId,
    closedAt: deal.closedAt,
    lostReason: deal.lostReason,
    lastActivityAt: deal.lastActivityAt,
    archivedAt: deal.archivedAt,
    createdAt: deal.createdAt,
    updatedAt: deal.updatedAt,
  }
}

export async function getDeal(ctx: ActorContext, id: string): Promise<Deal> {
  const [row] = await selectDeals(ctx).where(eq(schema.deals.id, id)).limit(1)
  if (!row) throw new NotFoundError('Deal', id)
  return present(row)
}

export async function loadDeal(ctx: ActorContext, id: string, options: { lock?: boolean } = {}) {
  const query = ctx.tx.select().from(schema.deals).where(eq(schema.deals.id, id)).limit(1)
  const [row] = options.lock ? await query.for('update') : await query
  if (!row) throw new NotFoundError('Deal', id)
  return row
}

async function assertContactUsable(ctx: ActorContext, contactId: string | null | undefined) {
  if (!contactId) return
  refuseArchived(await loadContact(ctx, contactId), 'contact')
}

export const dealList = defineProcedure({
  name: 'deal.list',
  summary: 'Deals, newest first',
  permission: 'deal:read',
  readOnly: true,
  input: z.object({
    q: searchInput,
    stage: z.enum(schema.DEAL_STAGES).optional(),
    /** Only deals that are still in play. */
    open: queryFlag,
    companyId: z.uuid().optional(),
    contactId: z.uuid().optional(),
    includeArchived: queryFlag,
    ...pageInput,
  }),
  output: pageOutput(dealOutput),
  http: { method: 'GET', path: '/deals' },
  async handler(ctx, input) {
    const d = schema.deals
    const rows = await selectDeals(ctx)
      .where(
        and(
          input.includeArchived ? undefined : isNull(d.archivedAt),
          input.stage ? eq(d.stage, input.stage) : undefined,
          input.open ? isNull(d.closedAt) : undefined,
          input.companyId ? eq(d.companyId, input.companyId) : undefined,
          input.contactId ? eq(d.contactId, input.contactId) : undefined,
          input.q ? or(ilike(d.name, contains(input.q)), ilike(schema.companies.name, contains(input.q))) : undefined,
          input.cursor ? lt(d.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(d.id))
      .limit(input.limit + 1)
    return paginate(rows.map(present), input.limit)
  },
})

export const dealGet = defineProcedure({
  name: 'deal.get',
  summary: 'One deal, with its company and contact names',
  permission: 'deal:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: dealOutput,
  http: { method: 'GET', path: '/deals/{id}' },
  async handler(ctx, input) {
    return getDeal(ctx, input.id)
  },
})

export const dealPipeline = defineProcedure({
  name: 'deal.pipeline',
  summary: 'Deal counts and value by stage, totalled per currency',
  permission: 'deal:read',
  readOnly: true,
  input: z.object({
    /** Won and lost deals count only if they closed this recently. Open deals always count. */
    closedWithinDays: z.coerce.number().int().min(1).max(3650).default(90),
  }),
  output: z.object({
    stages: z.array(
      z.object({
        stage: z.enum(schema.DEAL_STAGES),
        count: z.number().int(),
        /**
         * One total per currency. Deals are not converted: the MVP records no
         * exchange rates for deals, and a silently converted pipeline is worse
         * than an honest multi-currency one.
         */
        totals: z.array(z.object({ currency: z.string(), valueMinor: z.number().int() })),
      }),
    ),
  }),
  // Not /deals/pipeline: that would be captured by /deals/{id}.
  http: { method: 'GET', path: '/pipeline' },
  async handler(ctx, input) {
    const d = schema.deals
    const since = new Date(ctx.now.getTime() - input.closedWithinDays * 86_400_000)
    const rows = await ctx.tx
      .select({
        stage: d.stage,
        currency: d.currency,
        count: sql<number>`count(*)::int`,
        // Summed as numeric and returned as text, so an overflow shows up as
        // an error below instead of wrapping silently.
        total: sql<string>`sum(${d.valueMinor})::text`,
      })
      .from(d)
      .where(and(isNull(d.archivedAt), or(isNull(d.closedAt), gte(d.closedAt, since))))
      .groupBy(d.stage, d.currency)

    return {
      stages: schema.DEAL_STAGES.map((stage) => {
        const matching = rows.filter((r) => r.stage === stage)
        return {
          stage,
          count: matching.reduce((n, r) => n + r.count, 0),
          totals: matching
            .map((r) => ({ currency: r.currency, valueMinor: Number(r.total) }))
            .sort((a, b) => a.currency.localeCompare(b.currency)),
        }
      }),
    }
  },
})

const details = {
  name: requiredText(200, 'Name'),
  valueMinor: minorAmount,
  currency: currencyCode,
  expectedCloseDate: z.iso.date().nullish(),
  contactId: z.uuid().nullish(),
  ownerId: z.uuid().nullish(),
}

/** Writes a deal and announces it. Shared with lead conversion. */
export async function insertDeal(
  ctx: ActorContext,
  values: Omit<typeof schema.deals.$inferInsert, 'id' | 'organizationId' | 'stage' | 'closedAt'> & {
    stage?: (typeof OPEN_DEAL_STAGES)[number]
  },
): Promise<Deal> {
  const id = newId()
  await ctx.tx.insert(schema.deals).values({
    ...values,
    id,
    organizationId: ctx.organizationId,
    createdBy: actingUserId(ctx),
  })
  const deal = await getDeal(ctx, id)
  await ctx.audit({ action: 'deal.created', entityType: 'deal', entityId: id, entityLabel: deal.name })
  await ctx.emit('deal.created', deal)
  return deal
}

export const dealCreate = defineProcedure({
  name: 'deal.create',
  summary: 'Open a deal with a company',
  permission: 'deal:create',
  input: z.object({
    companyId: z.uuid(),
    ...details,
    valueMinor: minorAmount.default(0),
    /** Defaults to the organization's base currency. */
    currency: currencyCode.optional(),
    /** Deals open in a pipeline stage; win or lose them with the stage endpoint. */
    stage: z.enum(OPEN_DEAL_STAGES).default('qualified'),
  }),
  output: dealOutput,
  http: { method: 'POST', path: '/deals', successStatus: 201 },
  emits: ['deal.created'],
  async handler(ctx, input) {
    refuseArchived(await loadCompany(ctx, input.companyId), 'company')
    await assertContactUsable(ctx, input.contactId)
    const ownerId = input.ownerId === undefined ? actingUserId(ctx) : input.ownerId
    await assertMember(ctx, ownerId)
    return insertDeal(ctx, {
      ...input,
      ownerId,
      currency: input.currency ?? (await baseCurrency(ctx)),
    })
  },
})

export const dealUpdate = defineProcedure({
  name: 'deal.update',
  summary: "Change a deal's details. Use the stage endpoint to move, win, or lose it.",
  permission: 'deal:update',
  input: z.object({
    id: z.uuid(),
    name: details.name.optional(),
    valueMinor: details.valueMinor.optional(),
    currency: details.currency.optional(),
    expectedCloseDate: details.expectedCloseDate,
    contactId: details.contactId,
    ownerId: details.ownerId,
  }),
  output: dealOutput,
  http: { method: 'PATCH', path: '/deals/{id}' },
  emits: ['deal.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadDeal(ctx, id, { lock: true })
    const patch = provided(fields)
    if (patch.contactId && patch.contactId !== before.contactId) await assertContactUsable(ctx, patch.contactId)
    if (patch.ownerId) await assertMember(ctx, patch.ownerId)

    const changes = diff(before as Record<string, unknown>, patch)
    if (!changes) return getDeal(ctx, id)

    await ctx.tx.update(schema.deals).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.deals.id, id))
    const deal = await getDeal(ctx, id)
    await ctx.audit({ action: 'deal.updated', entityType: 'deal', entityId: id, entityLabel: deal.name, changes })
    await ctx.emit('deal.updated', deal)
    return deal
  },
})

export const dealChangeStage = defineProcedure({
  name: 'deal.changeStage',
  summary: 'Move a deal to another stage, including won or lost',
  permission: 'deal:update',
  input: z
    .object({
      id: z.uuid(),
      stage: z.enum(schema.DEAL_STAGES),
      /** Why it was lost. Only accepted with `lost`. */
      lostReason: optionalText(1000),
    })
    .refine((v) => v.stage === 'lost' || !v.lostReason, {
      message: 'A lost reason only applies to a lost deal.',
      path: ['lostReason'],
    }),
  output: dealOutput.extend({ previousStage: z.enum(schema.DEAL_STAGES) }),
  http: { method: 'POST', path: '/deals/{id}/stage' },
  emits: ['deal.stage_changed', 'deal.won', 'deal.lost', 'company.became_client'],
  async handler(ctx, input) {
    const before = await loadDeal(ctx, input.id, { lock: true })
    refuseArchived(before, 'deal')
    const previousStage = before.stage as DealStage
    if (previousStage === input.stage && (input.stage !== 'lost' || (input.lostReason ?? null) === before.lostReason)) {
      return { ...(await getDeal(ctx, before.id)), previousStage }
    }

    const closing = input.stage === 'won' || input.stage === 'lost'
    await ctx.tx
      .update(schema.deals)
      .set({
        stage: input.stage,
        // Reopening clears the close; moving between won and lost re-stamps it.
        closedAt: closing ? ctx.now : null,
        lostReason: input.stage === 'lost' ? (input.lostReason ?? null) : null,
        updatedAt: ctx.now,
      })
      .where(eq(schema.deals.id, before.id))

    const deal = await getDeal(ctx, before.id)
    await ctx.audit({
      action: input.stage === 'won' ? 'deal.won' : input.stage === 'lost' ? 'deal.lost' : 'deal.stage_changed',
      entityType: 'deal',
      entityId: deal.id,
      entityLabel: deal.name,
      changes: { stage: { from: previousStage, to: input.stage } },
    })

    const payload = { ...deal, previousStage }
    await ctx.emit('deal.stage_changed', payload)
    if (input.stage === 'won') {
      await ctx.emit('deal.won', payload)
      // Winning work is what makes a company a client.
      await makeClient(ctx, await loadCompany(ctx, deal.companyId, { lock: true }))
    }
    if (input.stage === 'lost') await ctx.emit('deal.lost', payload)
    return payload
  },
})

export const dealArchive = defineProcedure({
  name: 'deal.archive',
  summary: 'Archive a deal. It leaves the pipeline but keeps its history.',
  permission: 'deal:archive',
  input: z.object({ id: z.uuid() }),
  output: dealOutput,
  http: { method: 'DELETE', path: '/deals/{id}' },
  emits: ['deal.archived'],
  async handler(ctx, input) {
    const before = await loadDeal(ctx, input.id, { lock: true })
    if (before.archivedAt) return getDeal(ctx, before.id)
    await ctx.tx
      .update(schema.deals)
      .set({ archivedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(schema.deals.id, before.id))
    const deal = await getDeal(ctx, before.id)
    await ctx.audit({ action: 'deal.archived', entityType: 'deal', entityId: deal.id, entityLabel: deal.name })
    await ctx.emit('deal.archived', deal)
    return deal
  },
})

export const dealRestore = defineProcedure({
  name: 'deal.restore',
  summary: 'Restore an archived deal',
  permission: 'deal:archive',
  input: z.object({ id: z.uuid() }),
  output: dealOutput,
  http: { method: 'POST', path: '/deals/{id}/restore' },
  emits: ['deal.restored'],
  async handler(ctx, input) {
    const before = await loadDeal(ctx, input.id, { lock: true })
    if (!before.archivedAt) return getDeal(ctx, before.id)
    const company = await loadCompany(ctx, before.companyId)
    if (company.archivedAt) {
      throw new DomainError('Its company is archived. Restore the company first.', 'archived')
    }
    await ctx.tx
      .update(schema.deals)
      .set({ archivedAt: null, updatedAt: ctx.now })
      .where(eq(schema.deals.id, before.id))
    const deal = await getDeal(ctx, before.id)
    await ctx.audit({ action: 'deal.restored', entityType: 'deal', entityId: deal.id, entityLabel: deal.name })
    await ctx.emit('deal.restored', deal)
    return deal
  },
})
