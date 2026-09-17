import { and, asc, count, desc, eq, ilike, isNotNull, isNull, lt, lte, or, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from '../crm/companies.ts'
import {
  actingUserId,
  assertMember,
  contains,
  currencyCode,
  minorAmount,
  optionalText,
  optionalWebsite,
  pageInput,
  pageOutput,
  paginate,
  provided,
  queryFlag,
  requiredText,
  searchInput,
} from '../crm/shared.ts'
import { today } from '../finance/documents.ts'
import { loadProject } from '../projects/projects.ts'

/**
 * Infrastructure.
 *
 * Domains, hosting, servers, applications, certificates -- what the agency runs
 * on a client's behalf, and when each of them next needs paying for. The whole
 * module exists for `expiresOn`: a domain that lapses takes a client's site
 * with it, and the agency is who gets the call.
 *
 * There are deliberately no credentials here; see the schema for why.
 */

type AssetRow = typeof schema.infrastructureAssets.$inferSelect

export const infrastructureAssetOutput = z.object({
  id: z.uuid(),
  kind: z.enum(schema.ASSET_KINDS),
  name: z.string(),
  provider: z.string().nullable(),
  url: z.string().nullable(),
  environment: z.enum(schema.ASSET_ENVIRONMENTS),
  status: z.enum(schema.ASSET_STATUSES),
  companyId: z.uuid().nullable(),
  companyName: z.string().nullable(),
  projectId: z.uuid().nullable(),
  projectName: z.string().nullable(),
  expiresOn: z.iso.date().nullable(),
  /** Days until it expires; negative once it has. Null without a date. */
  daysUntilExpiry: z.number().int().nullable(),
  autoRenew: z.boolean(),
  renewalCostMinor: z.number().int().nullable(),
  currency: z.string().length(3).nullable(),
  ownerId: z.uuid().nullable(),
  ownerName: z.string().nullable(),
  notes: z.string().nullable(),
  decommissionedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type InfrastructureAsset = z.infer<typeof infrastructureAssetOutput>

type AssetJoin = { asset: AssetRow; companyName: string | null; projectName: string | null; ownerName: string | null }

/** Whole days between two calendar dates, in the organization's own reckoning. */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

function presentAsset(row: AssetJoin, todayOn: string): InfrastructureAsset {
  const a = row.asset
  return {
    id: a.id,
    kind: a.kind as InfrastructureAsset['kind'],
    name: a.name,
    provider: a.provider,
    url: a.url,
    environment: a.environment as InfrastructureAsset['environment'],
    status: a.status as InfrastructureAsset['status'],
    companyId: a.companyId,
    companyName: row.companyName,
    projectId: a.projectId,
    projectName: row.projectName,
    expiresOn: a.expiresOn,
    daysUntilExpiry: a.expiresOn ? daysBetween(todayOn, a.expiresOn) : null,
    autoRenew: a.autoRenew,
    renewalCostMinor: a.renewalCostMinor,
    currency: a.currency,
    ownerId: a.ownerId,
    ownerName: row.ownerName,
    notes: a.notes,
    decommissionedAt: a.decommissionedAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

function selectAssets(ctx: ActorContext) {
  return ctx.tx
    .select({
      asset: schema.infrastructureAssets,
      companyName: schema.companies.name,
      projectName: schema.projects.name,
      ownerName: schema.user.name,
    })
    .from(schema.infrastructureAssets)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.infrastructureAssets.companyId))
    .leftJoin(schema.projects, eq(schema.projects.id, schema.infrastructureAssets.projectId))
    .leftJoin(schema.user, eq(schema.user.id, schema.infrastructureAssets.ownerId))
}

export async function getAsset(ctx: ActorContext, id: string): Promise<InfrastructureAsset> {
  const [row] = await selectAssets(ctx).where(eq(schema.infrastructureAssets.id, id)).limit(1)
  if (!row) throw new NotFoundError('Asset', id)
  return presentAsset(row, await today(ctx))
}

async function loadAsset(ctx: ActorContext, id: string, options: { lock?: boolean } = {}): Promise<AssetRow> {
  const query = ctx.tx.select().from(schema.infrastructureAssets).where(eq(schema.infrastructureAssets.id, id)).limit(1)
  const [row] = await (options.lock ? query.for('update') : query)
  if (!row) throw new NotFoundError('Asset', id)
  return row
}

async function resolveAssetLinks(
  ctx: ActorContext,
  input: { companyId?: string | null | undefined; projectId?: string | null | undefined },
  current: { companyId: string | null } = { companyId: null },
) {
  const companyId = input.companyId !== undefined ? input.companyId : current.companyId
  if (companyId) await loadCompany(ctx, companyId)
  if (input.projectId) {
    const project = await loadProject(ctx, input.projectId)
    if (companyId && project.companyId !== companyId) {
      throw new DomainError('That project is for a different client.', 'project_company_mismatch', 'projectId')
    }
  }
  return { companyId: companyId ?? null }
}

// Reads

export const infrastructureAssetList = defineProcedure({
  name: 'infrastructureAsset.list',
  summary: 'Infrastructure, filtered by client, kind, status, environment, or how soon it expires',
  permission: 'infrastructure:read',
  readOnly: true,
  input: z.object({
    companyId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    kind: z.enum(schema.ASSET_KINDS).optional(),
    status: z.enum(schema.ASSET_STATUSES).optional(),
    environment: z.enum(schema.ASSET_ENVIRONMENTS).optional(),
    /** Expiring within this many days, including anything already expired. */
    expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
    /** The agency's own, rather than a client's. */
    internal: queryFlag,
    /** Matches the name, the provider, or the address. */
    q: searchInput,
    ...pageInput,
  }),
  output: pageOutput(infrastructureAssetOutput),
  http: { method: 'GET', path: '/infrastructure/assets' },
  async handler(ctx, input) {
    const a = schema.infrastructureAssets
    if (input.companyId) await loadCompany(ctx, input.companyId)
    if (input.projectId) await loadProject(ctx, input.projectId)
    const todayOn = await today(ctx)

    const horizon =
      input.expiringWithinDays === undefined
        ? undefined
        : new Date(Date.parse(`${todayOn}T00:00:00Z`) + input.expiringWithinDays * 86_400_000).toISOString().slice(0, 10)

    const conditions: Array<SQL | undefined> = [
      input.companyId ? eq(a.companyId, input.companyId) : undefined,
      input.internal ? isNull(a.companyId) : undefined,
      input.projectId ? eq(a.projectId, input.projectId) : undefined,
      input.kind ? eq(a.kind, input.kind) : undefined,
      input.status ? eq(a.status, input.status) : undefined,
      input.environment ? eq(a.environment, input.environment) : undefined,
      horizon ? and(isNotNull(a.expiresOn), lte(a.expiresOn, horizon)) : undefined,
      input.q ? or(ilike(a.name, contains(input.q)), ilike(a.provider, contains(input.q)), ilike(a.url, contains(input.q))) : undefined,
      input.cursor ? lt(a.id, input.cursor) : undefined,
    ]
    // Soonest expiry first when that is what was asked for; otherwise newest.
    const rows = await selectAssets(ctx)
      .where(and(...conditions))
      .orderBy(...(horizon ? [asc(a.expiresOn), desc(a.id)] : [desc(a.id)]))
      .limit(input.limit + 1)
    return paginate(
      rows.map((row) => presentAsset(row, todayOn)),
      input.limit,
    )
  },
})

export const infrastructureAssetGet = defineProcedure({
  name: 'infrastructureAsset.get',
  summary: 'One piece of infrastructure, and how long until it expires',
  permission: 'infrastructure:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: infrastructureAssetOutput,
  http: { method: 'GET', path: '/infrastructure/assets/{id}' },
  async handler(ctx, input) {
    return getAsset(ctx, input.id)
  },
})

// Writes

const assetFields = {
  kind: z.enum(schema.ASSET_KINDS).optional(),
  provider: optionalText(200),
  url: optionalWebsite,
  environment: z.enum(schema.ASSET_ENVIRONMENTS).optional(),
  /** The client it belongs to. Null for the agency's own. */
  companyId: z.uuid().nullish(),
  projectId: z.uuid().nullish(),
  expiresOn: z.iso.date().nullish(),
  autoRenew: z.boolean().optional(),
  renewalCostMinor: minorAmount.nullish(),
  currency: currencyCode.nullish(),
  ownerId: z.uuid().nullish(),
  notes: optionalText(10_000),
}

/** A cost needs a currency, and a currency without a cost says nothing. */
function assertCost(cost: number | null | undefined, currency: string | null | undefined) {
  if ((cost ?? null) === null && (currency ?? null) !== null) {
    throw new DomainError('Enter the renewal cost, or clear the currency.', 'cost_required', 'renewalCostMinor')
  }
  if ((cost ?? null) !== null && (currency ?? null) === null) {
    throw new DomainError('Choose the currency the renewal is paid in.', 'currency_required', 'currency')
  }
}

export const infrastructureAssetCreate = defineProcedure({
  name: 'infrastructureAsset.create',
  summary: 'Record a domain, host, server, application, or certificate',
  permission: 'infrastructure:create',
  input: z.object({ name: requiredText(200, 'Name'), ...assetFields }),
  output: infrastructureAssetOutput,
  http: { method: 'POST', path: '/infrastructure/assets', successStatus: 201 },
  emits: ['infrastructure_asset.created'],
  async handler(ctx, input) {
    const links = await resolveAssetLinks(ctx, input)
    await assertMember(ctx, input.ownerId)
    assertCost(input.renewalCostMinor, input.currency)

    const id = newId()
    await ctx.tx.insert(schema.infrastructureAssets).values({
      id,
      organizationId: ctx.organizationId,
      ...links,
      projectId: input.projectId ?? null,
      kind: input.kind ?? 'other',
      name: input.name,
      provider: input.provider ?? null,
      url: input.url ?? null,
      environment: input.environment ?? 'production',
      status: 'active',
      expiresOn: input.expiresOn ?? null,
      autoRenew: input.autoRenew ?? false,
      renewalCostMinor: input.renewalCostMinor ?? null,
      currency: input.currency ?? null,
      ownerId: input.ownerId ?? null,
      notes: input.notes ?? null,
      createdBy: actingUserId(ctx),
    })

    const asset = await getAsset(ctx, id)
    await ctx.audit({ action: 'infrastructure_asset.created', entityType: 'infrastructure_asset', entityId: id, entityLabel: asset.name })
    await ctx.emit('infrastructure_asset.created', asset)
    return asset
  },
})

export const infrastructureAssetUpdate = defineProcedure({
  name: 'infrastructureAsset.update',
  summary: 'Change a piece of infrastructure, including renewing it',
  permission: 'infrastructure:update',
  input: z.object({
    id: z.uuid(),
    name: requiredText(200, 'Name').optional(),
    status: z.enum(schema.ASSET_STATUSES).optional(),
    ...assetFields,
  }),
  output: infrastructureAssetOutput,
  http: { method: 'PATCH', path: '/infrastructure/assets/{id}' },
  emits: ['infrastructure_asset.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadAsset(ctx, id, { lock: true })
    await assertMember(ctx, fields.ownerId)
    const links = await resolveAssetLinks(ctx, fields, before)
    assertCost(
      fields.renewalCostMinor !== undefined ? fields.renewalCostMinor : before.renewalCostMinor,
      fields.currency !== undefined ? fields.currency : before.currency,
    )

    const patch = { ...provided(fields), ...links } as Partial<AssetRow>
    // A renewal moves the date, which arms the expiry notice again.
    if (patch.expiresOn !== undefined && patch.expiresOn !== before.expiresOn) patch.expiryNoticeSentFor = null
    if (patch.status !== undefined) {
      patch.decommissionedAt = patch.status === 'decommissioned' ? (before.decommissionedAt ?? ctx.now) : null
    }

    const changes = diff(before as unknown as Record<string, unknown>, patch)
    if (!changes) return getAsset(ctx, id)

    await ctx.tx.update(schema.infrastructureAssets).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.infrastructureAssets.id, id))
    const asset = await getAsset(ctx, id)
    await ctx.audit({ action: 'infrastructure_asset.updated', entityType: 'infrastructure_asset', entityId: id, entityLabel: asset.name, changes })
    await ctx.emit('infrastructure_asset.updated', asset)
    return asset
  },
})

export const infrastructureAssetDelete = defineProcedure({
  name: 'infrastructureAsset.delete',
  summary: 'Delete a record of infrastructure. Mark it decommissioned instead to keep the history.',
  permission: 'infrastructure:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/infrastructure/assets/{id}' },
  emits: ['infrastructure_asset.deleted'],
  async handler(ctx, input) {
    const asset = await getAsset(ctx, input.id)
    await ctx.tx.delete(schema.infrastructureAssets).where(eq(schema.infrastructureAssets.id, input.id))
    await ctx.audit({ action: 'infrastructure_asset.deleted', entityType: 'infrastructure_asset', entityId: asset.id, entityLabel: asset.name })
    await ctx.emit('infrastructure_asset.deleted', asset)
    return { deleted: true }
  },
})

/**
 * The renewal sweep, run by the worker once an hour per organization.
 *
 * Announces each asset approaching its renewal date once -- `expiry_notice_sent_for`
 * remembers which date was announced, so a renewal that moves the date arms it
 * again -- and marks as expired anything whose date has passed without one.
 * Assets set to renew themselves are still announced: "auto-renew" is a setting
 * at a registrar, not a fact, and the card on file expires too.
 */
export const EXPIRY_HORIZON_DAYS = 30

export async function sweepExpiringAssets(ctx: ActorContext, horizonDays = EXPIRY_HORIZON_DAYS): Promise<number> {
  const a = schema.infrastructureAssets
  const todayOn = await today(ctx)
  const horizon = new Date(Date.parse(`${todayOn}T00:00:00Z`) + horizonDays * 86_400_000).toISOString().slice(0, 10)

  const due = await selectAssets(ctx)
    .where(
      and(
        isNotNull(a.expiresOn),
        lte(a.expiresOn, horizon),
        sql`${a.status} not in ('decommissioned', 'expired')`,
        or(isNull(a.expiryNoticeSentFor), sql`${a.expiryNoticeSentFor} is distinct from ${a.expiresOn}`),
      ),
    )
    .orderBy(asc(a.expiresOn))
    .limit(500)

  let announced = 0
  for (const row of due) {
    const expired = row.asset.expiresOn! < todayOn
    await ctx.tx
      .update(a)
      .set({
        expiryNoticeSentFor: row.asset.expiresOn,
        ...(expired ? { status: 'expired' as const } : {}),
        updatedAt: ctx.now,
      })
      .where(eq(a.id, row.asset.id))

    const asset = await getAsset(ctx, row.asset.id)
    await ctx.audit({
      action: expired ? 'infrastructure_asset.expired' : 'infrastructure_asset.expiring',
      entityType: 'infrastructure_asset',
      entityId: asset.id,
      entityLabel: asset.name,
    })
    await ctx.emit(expired ? 'infrastructure_asset.expired' : 'infrastructure_asset.expiring', asset)
    announced += 1
  }
  return announced
}

/** Live infrastructure for a client, for the client view's Infrastructure tab. */
export async function countAssets(ctx: ActorContext, companyId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ n: count() })
    .from(schema.infrastructureAssets)
    .where(
      and(eq(schema.infrastructureAssets.companyId, companyId), sql`${schema.infrastructureAssets.status} <> 'decommissioned'`),
    )
  return row?.n ?? 0
}
