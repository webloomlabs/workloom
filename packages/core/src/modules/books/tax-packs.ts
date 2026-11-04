import { and, desc, eq, inArray, schema } from '@workloom/db'
import { storage } from '@workloom/storage'
import { z } from 'zod'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { packFiles } from '../../reports/tax-pack.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId } from '../crm/shared.ts'
import { collectPackInput, yearFor } from './books.ts'

/**
 * Income tax packs: a year's books, zipped for the accountant. Asking for one
 * records the request; the worker builds it (`buildDueTaxPacks`), since a year
 * of receipts can take a while to gather.
 */

const summaryOutput = z.object({
  income: z.number().int(),
  deductible: z.number().int(),
  nonDeductible: z.number().int(),
  capital: z.number().int(),
  accountingProfit: z.number().int(),
  adjustedProfit: z.number().int(),
  invoices: z.number().int(),
  expenses: z.number().int(),
  receipts: z.number().int(),
})

const warningOutput = z.object({ code: z.string(), message: z.string(), count: z.number().int() })

export const taxPackOutput = z.object({
  id: z.uuid(),
  label: z.string(),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  status: z.enum(schema.TAX_PACK_STATUSES),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  summary: summaryOutput.nullable(),
  warnings: z.array(warningOutput),
  error: z.string().nullable(),
  requestedAt: z.date(),
  completedAt: z.date().nullable(),
})

type PackRow = typeof schema.taxPacks.$inferSelect

function present(row: PackRow): z.infer<typeof taxPackOutput> {
  return {
    id: row.id,
    label: row.label,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status as (typeof schema.TAX_PACK_STATUSES)[number],
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    summary: (row.summary as z.infer<typeof summaryOutput> | null) ?? null,
    warnings: (row.warnings as Array<z.infer<typeof warningOutput>> | null) ?? [],
    error: row.error,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt,
  }
}

export function packSummary(built: ReturnType<typeof packFiles>, input: { invoices: unknown[]; expenses: Array<{ receipts: unknown[] }> }) {
  const { pnl } = built
  return {
    income: pnl.income,
    deductible: pnl.deductible,
    nonDeductible: pnl.nonDeductible,
    capital: pnl.capital,
    accountingProfit: pnl.accountingProfit,
    adjustedProfit: pnl.adjustedProfit,
    invoices: input.invoices.length,
    expenses: input.expenses.length,
    receipts: input.expenses.reduce((n, e) => n + e.receipts.length, 0),
  }
}

const yearInput = z.object({ startYear: z.number().int().min(2000).max(2100) })

export const taxPackPreflight = defineProcedure({
  name: 'taxPack.preflight',
  summary: "A year's figures and what to fix before packing them: drafts, missing receipts, open books",
  permission: 'report:readFinancial',
  readOnly: true,
  input: yearInput,
  output: z.object({ label: z.string(), from: z.iso.date(), to: z.iso.date(), summary: summaryOutput, warnings: z.array(warningOutput) }),
  http: { method: 'GET', path: '/tax-packs/preflight' },
  async handler(ctx, input) {
    const year = await yearFor(ctx, input.startYear)
    const collected = await collectPackInput(ctx, year, ctx.now)
    const built = packFiles(collected)
    return { label: year.label, from: year.from, to: year.to, summary: packSummary(built, collected), warnings: built.warnings }
  },
})

export const taxPackRequest = defineProcedure({
  name: 'taxPack.request',
  summary: 'Ask for a financial year’s income tax pack. It is built in the background; list the packs to see when it is ready.',
  permission: 'report:readFinancial',
  input: yearInput,
  output: taxPackOutput,
  http: { method: 'POST', path: '/tax-packs', successStatus: 201 },
  rateLimit: 'expensive',
  emits: [],
  async handler(ctx, input) {
    const year = await yearFor(ctx, input.startYear)
    const [waiting] = await ctx.tx
      .select({ id: schema.taxPacks.id })
      .from(schema.taxPacks)
      .where(and(eq(schema.taxPacks.periodStart, year.from), eq(schema.taxPacks.status, 'pending')))
      .limit(1)
    if (waiting) throw new DomainError(`The ${year.label} pack is already being made.`, 'pack_pending')
    const id = newId()
    await ctx.tx.insert(schema.taxPacks).values({ id, organizationId: ctx.organizationId, periodStart: year.from, periodEnd: year.to, label: year.label, requestedBy: actingUserId(ctx), requestedAt: ctx.now })
    await ctx.audit({ action: 'tax_pack.requested', entityType: 'tax_pack', entityId: id, entityLabel: `Year of assessment ${year.label}` })
    const [row] = await ctx.tx.select().from(schema.taxPacks).where(eq(schema.taxPacks.id, id))
    return present(row!)
  },
})

export const taxPackList = defineProcedure({
  name: 'taxPack.list',
  summary: 'The tax packs asked for, newest first',
  permission: 'report:readFinancial',
  readOnly: true,
  input: z.object({}),
  output: z.object({ data: z.array(taxPackOutput) }),
  http: { method: 'GET', path: '/tax-packs' },
  async handler(ctx) {
    const rows = await ctx.tx.select().from(schema.taxPacks).orderBy(desc(schema.taxPacks.requestedAt)).limit(50)
    return { data: rows.map(present) }
  },
})

async function loadPack(ctx: ActorContext, id: string): Promise<PackRow> {
  const [row] = await ctx.tx.select().from(schema.taxPacks).where(eq(schema.taxPacks.id, id)).limit(1)
  if (!row) throw new NotFoundError('Tax pack', id)
  return row
}

export const taxPackDownload = defineProcedure({
  name: 'taxPack.download',
  summary: 'A short-lived link to a ready tax pack',
  permission: 'report:readFinancial',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: z.object({ url: z.string(), filename: z.string(), expiresAt: z.date() }),
  http: { method: 'GET', path: '/tax-packs/{id}/download' },
  async handler(ctx, input) {
    const row = await loadPack(ctx, input.id)
    if (row.status !== 'ready' || !row.storageKey) throw new DomainError('This pack is not ready.', 'pack_not_ready')
    const filename = `Tax pack ${row.label.replace('/', '-')}.zip`
    const expiresInSeconds = 300
    const url = await storage().signedUrl(row.storageKey, { expiresInSeconds, filename, contentType: 'application/zip' })
    return { url, filename, expiresAt: new Date(ctx.now.getTime() + expiresInSeconds * 1000) }
  },
})

/** Pending packs for the worker, oldest first. */
export async function pendingPacks(ctx: ActorContext): Promise<PackRow[]> {
  return ctx.tx.select().from(schema.taxPacks).where(inArray(schema.taxPacks.status, ['pending'])).orderBy(schema.taxPacks.requestedAt).limit(5)
}
