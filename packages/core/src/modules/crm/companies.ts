import { and, desc, eq, ilike, isNull, lt, or, schema } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import {
  actingUserId,
  assertMember,
  contains,
  optionalEmail,
  optionalText,
  optionalWebsite,
  pageInput,
  pageOutput,
  paginate,
  provided,
  queryFlag,
  requiredText,
  searchInput,
} from './shared.ts'

export const companyOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  website: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  industry: z.string().nullable(),
  address: z.string().nullable(),
  description: z.string().nullable(),
  /** `client` is what makes a company a client; there is no separate client record. */
  lifecycleStage: z.enum(schema.COMPANY_LIFECYCLE_STAGES),
  becameClientAt: z.date().nullable(),
  ownerId: z.uuid().nullable(),
  lastActivityAt: z.date().nullable(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type CompanyRow = typeof schema.companies.$inferSelect
export type Company = z.infer<typeof companyOutput>

export function presentCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    website: row.website,
    email: row.email,
    phone: row.phone,
    industry: row.industry,
    address: row.address,
    description: row.description,
    lifecycleStage: row.lifecycleStage as Company['lifecycleStage'],
    becameClientAt: row.becameClientAt,
    ownerId: row.ownerId,
    lastActivityAt: row.lastActivityAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function loadCompany(ctx: ActorContext, id: string, options: { lock?: boolean } = {}) {
  const query = ctx.tx.select().from(schema.companies).where(eq(schema.companies.id, id)).limit(1)
  const [row] = options.lock ? await query.for('update') : await query
  if (!row) throw new NotFoundError('Company', id)
  return row
}

const details = {
  website: optionalWebsite,
  email: optionalEmail,
  phone: optionalText(50),
  industry: optionalText(100),
  address: optionalText(500),
  description: optionalText(5000),
}

export const companyList = defineProcedure({
  name: 'company.list',
  summary: 'Companies, newest first',
  permission: 'company:read',
  readOnly: true,
  input: z.object({
    q: searchInput,
    lifecycleStage: z.enum(schema.COMPANY_LIFECYCLE_STAGES).optional(),
    includeArchived: queryFlag,
    ...pageInput,
  }),
  output: pageOutput(companyOutput),
  http: { method: 'GET', path: '/companies' },
  async handler(ctx, input) {
    const c = schema.companies
    const rows = await ctx.tx
      .select()
      .from(c)
      .where(
        and(
          input.includeArchived ? undefined : isNull(c.archivedAt),
          input.lifecycleStage ? eq(c.lifecycleStage, input.lifecycleStage) : undefined,
          input.q ? or(ilike(c.name, contains(input.q)), ilike(c.website, contains(input.q))) : undefined,
          input.cursor ? lt(c.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(c.id))
      .limit(input.limit + 1)
    return paginate(rows.map(presentCompany), input.limit)
  },
})

export const companyGet = defineProcedure({
  name: 'company.get',
  summary: 'One company, by id',
  permission: 'company:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: companyOutput,
  http: { method: 'GET', path: '/companies/{id}' },
  async handler(ctx, input) {
    return presentCompany(await loadCompany(ctx, input.id))
  },
})

/**
 * Writes a company and announces it. Shared with lead conversion, so a company
 * created either way is audited and emitted identically.
 */
export async function insertCompany(
  ctx: ActorContext,
  values: Omit<typeof schema.companies.$inferInsert, 'id' | 'organizationId'>,
  audit: { action: string } = { action: 'company.created' },
): Promise<Company> {
  const client = values.lifecycleStage === 'client'
  const [row] = await ctx.tx
    .insert(schema.companies)
    .values({
      ...values,
      id: newId(),
      organizationId: ctx.organizationId,
      becameClientAt: client ? ctx.now : null,
      createdBy: actingUserId(ctx),
    })
    .returning()
  const company = presentCompany(row!)

  await ctx.audit({ action: audit.action, entityType: 'company', entityId: company.id, entityLabel: company.name })
  await ctx.emit('company.created', company)
  if (client) await ctx.emit('company.became_client', company)
  return company
}

/**
 * Promotes a company to client, if it is not one already. The audit entry that
 * caused it -- the deal won, the lead converted -- shares this request id.
 */
export async function makeClient(ctx: ActorContext, row: CompanyRow): Promise<Company> {
  if (row.lifecycleStage === 'client') return presentCompany(row)
  const [after] = await ctx.tx
    .update(schema.companies)
    .set({ lifecycleStage: 'client', becameClientAt: row.becameClientAt ?? ctx.now, updatedAt: ctx.now })
    .where(eq(schema.companies.id, row.id))
    .returning()
  const company = presentCompany(after!)
  await ctx.audit({
    action: 'company.became_client',
    entityType: 'company',
    entityId: row.id,
    entityLabel: row.name,
    changes: { lifecycleStage: { from: row.lifecycleStage, to: 'client' } },
  })
  await ctx.emit('company.became_client', company)
  return company
}

export const companyCreate = defineProcedure({
  name: 'company.create',
  summary: 'Add a company',
  permission: 'company:create',
  input: z.object({
    name: requiredText(200, 'Name'),
    ...details,
    lifecycleStage: z.enum(schema.COMPANY_LIFECYCLE_STAGES).default('prospect'),
    /** Defaults to the person creating it. */
    ownerId: z.uuid().nullish(),
  }),
  output: companyOutput,
  http: { method: 'POST', path: '/companies', successStatus: 201 },
  emits: ['company.created', 'company.became_client'],
  async handler(ctx, input) {
    const ownerId = input.ownerId === undefined ? actingUserId(ctx) : input.ownerId
    await assertMember(ctx, ownerId)
    return insertCompany(ctx, { ...input, ownerId })
  },
})

export const companyUpdate = defineProcedure({
  name: 'company.update',
  summary: 'Change a company',
  permission: 'company:update',
  input: z.object({
    id: z.uuid(),
    name: requiredText(200, 'Name').optional(),
    ...details,
    lifecycleStage: z.enum(schema.COMPANY_LIFECYCLE_STAGES).optional(),
    ownerId: z.uuid().nullish(),
  }),
  output: companyOutput,
  http: { method: 'PATCH', path: '/companies/{id}' },
  emits: ['company.updated', 'company.became_client'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadCompany(ctx, id, { lock: true })
    const patch = provided(fields)
    if (patch.ownerId) await assertMember(ctx, patch.ownerId)

    const changes = diff(before as Record<string, unknown>, patch)
    if (!changes) return presentCompany(before)

    const becomingClient = patch.lifecycleStage === 'client' && before.lifecycleStage !== 'client'
    const [after] = await ctx.tx
      .update(schema.companies)
      .set({
        ...patch,
        ...(becomingClient ? { becameClientAt: before.becameClientAt ?? ctx.now } : {}),
        updatedAt: ctx.now,
      })
      .where(eq(schema.companies.id, id))
      .returning()
    const company = presentCompany(after!)

    await ctx.audit({ action: 'company.updated', entityType: 'company', entityId: id, entityLabel: company.name, changes })
    await ctx.emit('company.updated', company)
    if (becomingClient) await ctx.emit('company.became_client', company)
    return company
  },
})

export const companyArchive = defineProcedure({
  name: 'company.archive',
  summary: 'Archive a company. It is hidden from lists but keeps its history.',
  permission: 'company:archive',
  input: z.object({ id: z.uuid() }),
  output: companyOutput,
  http: { method: 'DELETE', path: '/companies/{id}' },
  emits: ['company.archived'],
  async handler(ctx, input) {
    const before = await loadCompany(ctx, input.id, { lock: true })
    if (before.archivedAt) return presentCompany(before)

    const [openDeal] = await ctx.tx
      .select({ id: schema.deals.id })
      .from(schema.deals)
      .where(
        and(
          eq(schema.deals.companyId, before.id),
          isNull(schema.deals.archivedAt),
          isNull(schema.deals.closedAt),
        ),
      )
      .limit(1)
    if (openDeal) {
      throw new DomainError(
        'This company has open deals. Close or archive them before archiving the company.',
        'has_open_deals',
      )
    }

    const [after] = await ctx.tx
      .update(schema.companies)
      .set({ archivedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(schema.companies.id, before.id))
      .returning()
    const company = presentCompany(after!)
    await ctx.audit({ action: 'company.archived', entityType: 'company', entityId: before.id, entityLabel: before.name })
    await ctx.emit('company.archived', company)
    return company
  },
})

export const companyRestore = defineProcedure({
  name: 'company.restore',
  summary: 'Restore an archived company',
  permission: 'company:archive',
  input: z.object({ id: z.uuid() }),
  output: companyOutput,
  http: { method: 'POST', path: '/companies/{id}/restore' },
  emits: ['company.restored'],
  async handler(ctx, input) {
    const before = await loadCompany(ctx, input.id, { lock: true })
    if (!before.archivedAt) return presentCompany(before)
    const [after] = await ctx.tx
      .update(schema.companies)
      .set({ archivedAt: null, updatedAt: ctx.now })
      .where(eq(schema.companies.id, before.id))
      .returning()
    const company = presentCompany(after!)
    await ctx.audit({ action: 'company.restored', entityType: 'company', entityId: before.id, entityLabel: before.name })
    await ctx.emit('company.restored', company)
    return company
  },
})
