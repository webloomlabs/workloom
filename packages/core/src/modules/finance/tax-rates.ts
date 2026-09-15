import { and, asc, eq, isNull, schema } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId, optionalText, provided, queryFlag, requiredText, violatedConstraint } from '../crm/shared.ts'
import { fromNumeric, percentInput } from './shared.ts'

type TaxRateRow = typeof schema.taxRates.$inferSelect

export const taxRateOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  /** A percentage as an exact decimal string: "10", "8.875". */
  rate: z.string(),
  description: z.string().nullable(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type TaxRate = z.infer<typeof taxRateOutput>

export function presentTaxRate(row: TaxRateRow): TaxRate {
  return {
    id: row.id,
    name: row.name,
    rate: fromNumeric(row.rate),
    description: row.description,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function loadTaxRate(ctx: ActorContext, id: string, options: { active?: boolean; field?: string } = {}): Promise<TaxRateRow> {
  const [row] = await ctx.tx.select().from(schema.taxRates).where(eq(schema.taxRates.id, id)).limit(1)
  if (!row) throw new NotFoundError('Tax rate', id)
  if (options.active && row.archivedAt) {
    throw new DomainError(`The tax rate "${row.name}" is archived.`, 'archived', options.field ?? 'taxRateId')
  }
  return row
}

async function withUniqueName<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (violatedConstraint(error) === 'tax_rates_organization_name_key') {
      throw new DomainError('A tax rate with this name already exists.', 'duplicate_name', 'name')
    }
    throw error
  }
}

/** Whether any document line uses the tax rate. S7b adds invoice lines here. */
async function inUse(ctx: ActorContext, id: string): Promise<boolean> {
  const [line] = await ctx.tx.select({ id: schema.quoteLines.id }).from(schema.quoteLines).where(eq(schema.quoteLines.taxRateId, id)).limit(1)
  return Boolean(line)
}

export const taxRateList = defineProcedure({
  name: 'taxRate.list',
  summary: 'Tax rates, by name',
  permission: 'taxRate:read',
  readOnly: true,
  input: z.object({ includeArchived: queryFlag }),
  output: z.object({ data: z.array(taxRateOutput) }),
  http: { method: 'GET', path: '/tax-rates' },
  async handler(ctx, input) {
    const t = schema.taxRates
    const rows = await ctx.tx
      .select()
      .from(t)
      .where(input.includeArchived ? undefined : isNull(t.archivedAt))
      .orderBy(asc(t.name))
    return { data: rows.map(presentTaxRate) }
  },
})

export const taxRateCreate = defineProcedure({
  name: 'taxRate.create',
  summary: 'Add a tax rate',
  permission: 'taxRate:create',
  input: z.object({ name: requiredText(100, 'Name'), rate: percentInput, description: optionalText(1000) }),
  output: taxRateOutput,
  http: { method: 'POST', path: '/tax-rates', successStatus: 201 },
  emits: ['tax_rate.created'],
  async handler(ctx, input) {
    const id = newId()
    const [row] = await withUniqueName(() =>
      ctx.tx
        .insert(schema.taxRates)
        .values({ id, organizationId: ctx.organizationId, name: input.name, rate: input.rate, description: input.description ?? null, createdBy: actingUserId(ctx) })
        .returning(),
    )
    const taxRate = presentTaxRate(row!)
    await ctx.audit({ action: 'tax_rate.created', entityType: 'tax_rate', entityId: id, entityLabel: `${taxRate.name} (${taxRate.rate}%)` })
    await ctx.emit('tax_rate.created', taxRate)
    return taxRate
  },
})

export const taxRateUpdate = defineProcedure({
  name: 'taxRate.update',
  summary: "Rename or describe a tax rate. Its rate can change only until a document uses it.",
  permission: 'taxRate:update',
  input: z.object({ id: z.uuid(), name: requiredText(100, 'Name').optional(), rate: percentInput.optional(), description: optionalText(1000) }),
  output: taxRateOutput,
  http: { method: 'PATCH', path: '/tax-rates/{id}' },
  emits: ['tax_rate.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadTaxRate(ctx, id)
    const patch = provided(fields)
    if (patch.rate !== undefined && patch.rate === fromNumeric(before.rate)) delete patch.rate
    if (patch.rate !== undefined && (await inUse(ctx, id))) {
      throw new DomainError(
        'This tax rate is used on documents, so its percentage cannot change. Archive it and add a new rate instead.',
        'tax_rate_in_use',
        'rate',
      )
    }
    const changes = diff({ ...before, rate: fromNumeric(before.rate) } as Record<string, unknown>, patch)
    if (!changes) return presentTaxRate(before)
    const [row] = await withUniqueName(() =>
      ctx.tx.update(schema.taxRates).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.taxRates.id, id)).returning(),
    )
    const taxRate = presentTaxRate(row!)
    await ctx.audit({ action: 'tax_rate.updated', entityType: 'tax_rate', entityId: id, entityLabel: taxRate.name, changes })
    await ctx.emit('tax_rate.updated', taxRate)
    return taxRate
  },
})

function archiveProcedure(archive: boolean) {
  return defineProcedure({
    name: archive ? 'taxRate.archive' : 'taxRate.restore',
    summary: archive ? 'Archive a tax rate. Documents that use it keep it.' : 'Restore an archived tax rate',
    permission: 'taxRate:archive',
    input: z.object({ id: z.uuid() }),
    output: taxRateOutput,
    http: archive ? { method: 'DELETE', path: '/tax-rates/{id}' } : { method: 'POST', path: '/tax-rates/{id}/restore' },
    emits: [archive ? 'tax_rate.archived' : 'tax_rate.restored'],
    async handler(ctx, input) {
      const before = await loadTaxRate(ctx, input.id)
      if (Boolean(before.archivedAt) === archive) return presentTaxRate(before)
      const [row] = await withUniqueName(() =>
        ctx.tx
          .update(schema.taxRates)
          .set({ archivedAt: archive ? ctx.now : null, updatedAt: ctx.now })
          .where(and(eq(schema.taxRates.id, before.id)))
          .returning(),
      )
      const action = archive ? 'tax_rate.archived' : 'tax_rate.restored'
      const taxRate = presentTaxRate(row!)
      await ctx.audit({ action, entityType: 'tax_rate', entityId: before.id, entityLabel: before.name })
      await ctx.emit(action, taxRate)
      return taxRate
    },
  })
}

export const taxRateArchive = archiveProcedure(true)
export const taxRateRestore = archiveProcedure(false)
