import { alias, and, asc, eq, ilike, isNull, schema } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId, baseCurrency, contains, currencyCode, minorAmount, optionalText, provided, queryFlag, requiredText, searchInput, violatedConstraint } from '../crm/shared.ts'
import { loadTaxRate } from './tax-rates.ts'

type ServiceRow = typeof schema.services.$inferSelect

export const serviceOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  pricingModel: z.enum(schema.SERVICE_PRICING_MODELS),
  billingType: z.enum(schema.SERVICE_BILLING_TYPES),
  /** What one of the quantity is: "hour", "page". */
  unit: z.string().nullable(),
  currency: z.string().length(3),
  /** Minor units of `currency` per unit. Null when there is no standard price. */
  defaultPriceMinor: z.number().int().nullable(),
  defaultTaxRateId: z.uuid().nullable(),
  defaultTaxRateName: z.string().nullable(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type Service = z.infer<typeof serviceOutput>

const defaultTax = alias(schema.taxRates, 'service_default_tax')

function selectServices(ctx: ActorContext) {
  return ctx.tx
    .select({ service: schema.services, taxName: defaultTax.name })
    .from(schema.services)
    .leftJoin(defaultTax, eq(defaultTax.id, schema.services.defaultTaxRateId))
}

function present({ service, taxName }: { service: ServiceRow; taxName: string | null }): Service {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    pricingModel: service.pricingModel as Service['pricingModel'],
    billingType: service.billingType as Service['billingType'],
    unit: service.unit,
    currency: service.currency,
    defaultPriceMinor: service.defaultPriceMinor,
    defaultTaxRateId: service.defaultTaxRateId,
    defaultTaxRateName: taxName,
    archivedAt: service.archivedAt,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  }
}

async function getService(ctx: ActorContext, id: string): Promise<Service> {
  const [row] = await selectServices(ctx).where(eq(schema.services.id, id)).limit(1)
  if (!row) throw new NotFoundError('Service', id)
  return present(row)
}

export async function loadService(ctx: ActorContext, id: string, options: { active?: boolean } = {}): Promise<ServiceRow> {
  const [row] = await ctx.tx.select().from(schema.services).where(eq(schema.services.id, id)).limit(1)
  if (!row) throw new NotFoundError('Service', id)
  if (options.active && row.archivedAt) throw new DomainError(`The service "${row.name}" is archived.`, 'archived', 'serviceId')
  return row
}

async function withUniqueName<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (violatedConstraint(error) === 'services_organization_name_key') {
      throw new DomainError('A service with this name already exists.', 'duplicate_name', 'name')
    }
    throw error
  }
}

const details = {
  description: optionalText(5000),
  pricingModel: z.enum(schema.SERVICE_PRICING_MODELS).optional(),
  billingType: z.enum(schema.SERVICE_BILLING_TYPES).optional(),
  unit: optionalText(50),
  defaultPriceMinor: minorAmount.nullish(),
  defaultTaxRateId: z.uuid().nullish(),
}

export const serviceList = defineProcedure({
  name: 'service.list',
  summary: 'The service catalogue, by name',
  permission: 'service:read',
  readOnly: true,
  input: z.object({ q: searchInput, includeArchived: queryFlag }),
  output: z.object({ data: z.array(serviceOutput) }),
  http: { method: 'GET', path: '/services' },
  async handler(ctx, input) {
    const s = schema.services
    const rows = await selectServices(ctx)
      .where(and(input.includeArchived ? undefined : isNull(s.archivedAt), input.q ? ilike(s.name, contains(input.q)) : undefined))
      .orderBy(asc(s.name))
    return { data: rows.map(present) }
  },
})

export const serviceGet = defineProcedure({
  name: 'service.get',
  summary: 'One service',
  permission: 'service:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: serviceOutput,
  http: { method: 'GET', path: '/services/{id}' },
  async handler(ctx, input) {
    return getService(ctx, input.id)
  },
})

export const serviceCreate = defineProcedure({
  name: 'service.create',
  summary: 'Add a service to the catalogue',
  permission: 'service:create',
  input: z.object({
    name: requiredText(200, 'Name'),
    ...details,
    /** Defaults to the organization's base currency. */
    currency: currencyCode.optional(),
  }),
  output: serviceOutput,
  http: { method: 'POST', path: '/services', successStatus: 201 },
  emits: ['service.created'],
  async handler(ctx, input) {
    if (input.defaultTaxRateId) await loadTaxRate(ctx, input.defaultTaxRateId, { active: true, field: 'defaultTaxRateId' })
    const id = newId()
    const currency = input.currency ?? (await baseCurrency(ctx))
    await withUniqueName(() =>
      ctx.tx.insert(schema.services).values({
        id,
        organizationId: ctx.organizationId,
        name: input.name,
        description: input.description ?? null,
        pricingModel: input.pricingModel ?? 'fixed',
        billingType: input.billingType ?? 'one_off',
        unit: input.unit ?? null,
        currency,
        defaultPriceMinor: input.defaultPriceMinor ?? null,
        defaultTaxRateId: input.defaultTaxRateId ?? null,
        createdBy: actingUserId(ctx),
      }),
    )
    const service = await getService(ctx, id)
    await ctx.audit({ action: 'service.created', entityType: 'service', entityId: id, entityLabel: service.name })
    await ctx.emit('service.created', service)
    return service
  },
})

export const serviceUpdate = defineProcedure({
  name: 'service.update',
  summary: "Change a service. Quotes already using it keep what they were given.",
  permission: 'service:update',
  input: z.object({ id: z.uuid(), name: requiredText(200, 'Name').optional(), ...details, currency: currencyCode.optional() }),
  output: serviceOutput,
  http: { method: 'PATCH', path: '/services/{id}' },
  emits: ['service.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadService(ctx, id)
    const patch = provided(fields)
    if (patch.defaultTaxRateId && patch.defaultTaxRateId !== before.defaultTaxRateId) {
      await loadTaxRate(ctx, patch.defaultTaxRateId, { active: true, field: 'defaultTaxRateId' })
    }
    const changes = diff(before as Record<string, unknown>, patch)
    if (!changes) return getService(ctx, id)
    await withUniqueName(() => ctx.tx.update(schema.services).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.services.id, id)))
    const service = await getService(ctx, id)
    await ctx.audit({ action: 'service.updated', entityType: 'service', entityId: id, entityLabel: service.name, changes })
    await ctx.emit('service.updated', service)
    return service
  },
})

function archiveProcedure(archive: boolean) {
  return defineProcedure({
    name: archive ? 'service.archive' : 'service.restore',
    summary: archive ? 'Archive a service. It can no longer be added to quotes.' : 'Restore an archived service',
    permission: 'service:archive',
    input: z.object({ id: z.uuid() }),
    output: serviceOutput,
    http: archive ? { method: 'DELETE', path: '/services/{id}' } : { method: 'POST', path: '/services/{id}/restore' },
    emits: [archive ? 'service.archived' : 'service.restored'],
    async handler(ctx, input) {
      const before = await loadService(ctx, input.id)
      if (Boolean(before.archivedAt) === archive) return getService(ctx, before.id)
      await withUniqueName(() =>
        ctx.tx.update(schema.services).set({ archivedAt: archive ? ctx.now : null, updatedAt: ctx.now }).where(eq(schema.services.id, before.id)),
      )
      const action = archive ? 'service.archived' : 'service.restored'
      const service = await getService(ctx, before.id)
      await ctx.audit({ action, entityType: 'service', entityId: before.id, entityLabel: before.name })
      await ctx.emit(action, service)
      return service
    },
  })
}

export const serviceArchive = archiveProcedure(true)
export const serviceRestore = archiveProcedure(false)
