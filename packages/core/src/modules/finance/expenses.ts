import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { convert, formatDecimal, parseDecimal, percentage, RATE_SCALE, toSafeNumber } from '../../money/money.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from '../crm/companies.ts'
import {
  actingUserId,
  baseCurrency,
  contains,
  currencyCode,
  minorAmount,
  optionalFlag,
  optionalText,
  pageInput,
  pageOutput,
  paginate,
  provided,
  requiredText,
  searchInput,
} from '../crm/shared.ts'
import { loadProject } from '../projects/projects.ts'
import { exchangeRateInput, taxSnapshot, today } from './documents.ts'
import { fromNumeric, percentInput } from './shared.ts'

/**
 * What the agency spent.
 *
 * Priced the way an invoice line is -- a net amount plus a snapshot of the tax
 * that applied -- because a billable expense becomes exactly that when it is
 * rebilled. Profitability (S8) costs the net amount: the tax is reclaimed, so
 * charging it to a project would overstate what the work cost.
 *
 * Once rebilled, an expense is frozen: the invoice line that bills it is a
 * statement to a client about a cost, and it cannot be edited out from under
 * them. Removing the line releases it. Both are enforced here and, again, by a
 * trigger in migration 0016.
 */

type ExpenseRow = typeof schema.expenses.$inferSelect

export const expenseOutput = z.object({
  id: z.uuid(),
  description: z.string(),
  supplier: z.string().nullable(),
  category: z.enum(schema.EXPENSE_CATEGORIES),
  incurredOn: z.iso.date(),
  projectId: z.uuid().nullable(),
  projectName: z.string().nullable(),
  companyId: z.uuid().nullable(),
  companyName: z.string().nullable(),
  currency: z.string().length(3),
  /** Net of tax: what it actually cost. */
  amountMinor: z.number().int(),
  taxRateId: z.uuid().nullable(),
  taxName: z.string().nullable(),
  taxRate: z.string().nullable(),
  taxMinor: z.number().int(),
  /** Net plus tax: what was paid out. */
  totalMinor: z.number().int(),
  baseCurrency: z.string().length(3),
  exchangeRateToBase: z.string(),
  amountBaseMinor: z.number().int(),
  billable: z.boolean(),
  markupPercent: z.string().nullable(),
  /** What it would be rebilled at: cost plus the markup. */
  rebillMinor: z.number().int(),
  /** The invoice line that rebilled it. Set, the expense can no longer change. */
  invoiceLineId: z.uuid().nullable(),
  invoiceId: z.uuid().nullable(),
  invoiceNumber: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type Expense = z.infer<typeof expenseOutput>

/** Cost plus the markup, which is what a rebilled line charges per unit. */
export function rebillAmount(amountMinor: number, markupPercent: string | null): number {
  if (markupPercent === null) return amountMinor
  return amountMinor + toSafeNumber(percentage(BigInt(amountMinor), markupPercent))
}

type ExpenseJoin = {
  expense: ExpenseRow
  projectName: string | null
  companyName: string | null
  invoiceId: string | null
  invoiceNumber: string | null
}

function presentExpense(row: ExpenseJoin): Expense {
  const e = row.expense
  return {
    id: e.id,
    description: e.description,
    supplier: e.supplier,
    category: e.category as Expense['category'],
    incurredOn: e.incurredOn,
    projectId: e.projectId,
    projectName: row.projectName,
    companyId: e.companyId,
    companyName: row.companyName,
    currency: e.currency,
    amountMinor: e.amountMinor,
    taxRateId: e.taxRateId,
    taxName: e.taxName,
    taxRate: fromNumeric(e.taxRatePctSnapshot),
    taxMinor: e.taxMinor,
    totalMinor: e.amountMinor + e.taxMinor,
    baseCurrency: e.baseCurrency,
    exchangeRateToBase: formatDecimal(parseDecimal(e.exchangeRateToBase, RATE_SCALE), RATE_SCALE),
    amountBaseMinor: e.amountBaseMinor,
    billable: e.billable,
    markupPercent: fromNumeric(e.markupPercent),
    rebillMinor: rebillAmount(e.amountMinor, fromNumeric(e.markupPercent)),
    invoiceLineId: e.invoiceLineId,
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoiceNumber,
    notes: e.notes,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }
}

function selectExpenses(ctx: ActorContext) {
  return ctx.tx
    .select({
      expense: schema.expenses,
      projectName: schema.projects.name,
      companyName: schema.companies.name,
      invoiceId: schema.invoiceLines.invoiceId,
      invoiceNumber: schema.invoices.number,
    })
    .from(schema.expenses)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.expenses.projectId))
    .leftJoin(schema.companies, eq(schema.companies.id, schema.expenses.companyId))
    .leftJoin(schema.invoiceLines, eq(schema.invoiceLines.id, schema.expenses.invoiceLineId))
    .leftJoin(schema.invoices, eq(schema.invoices.id, schema.invoiceLines.invoiceId))
}

export async function getExpense(ctx: ActorContext, id: string): Promise<Expense> {
  const [row] = await selectExpenses(ctx).where(eq(schema.expenses.id, id)).limit(1)
  if (!row) throw new NotFoundError('Expense', id)
  return presentExpense(row)
}

/** An expense that may still be changed. A rebilled one may not. */
async function loadChangeableExpense(ctx: ActorContext, id: string): Promise<ExpenseRow> {
  const [row] = await ctx.tx.select().from(schema.expenses).where(eq(schema.expenses.id, id)).limit(1).for('update')
  if (!row) throw new NotFoundError('Expense', id)
  if (row.invoiceLineId) {
    throw new DomainError(
      'This expense has been rebilled to the client. Remove it from the invoice first.',
      'expense_invoiced',
    )
  }
  return row
}

export const expenseList = defineProcedure({
  name: 'expense.list',
  summary: 'Expenses, newest first, filtered by project, client, category, date, or whether they are billable',
  permission: 'expense:read',
  readOnly: true,
  input: z.object({
    projectId: z.uuid().optional(),
    companyId: z.uuid().optional(),
    category: z.enum(schema.EXPENSE_CATEGORIES).optional(),
    /** Inclusive calendar dates against the day it was incurred. */
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    billable: optionalFlag,
    /** Whether it has been rebilled to a client. */
    invoiced: optionalFlag,
    /** Matches the description or the supplier. */
    q: searchInput,
    ...pageInput,
  }),
  output: pageOutput(expenseOutput),
  http: { method: 'GET', path: '/expenses' },
  async handler(ctx, input) {
    const e = schema.expenses
    if (input.projectId) await loadProject(ctx, input.projectId)
    if (input.companyId) await loadCompany(ctx, input.companyId)
    const conditions: Array<SQL | undefined> = [
      input.projectId ? eq(e.projectId, input.projectId) : undefined,
      input.companyId ? eq(e.companyId, input.companyId) : undefined,
      input.category ? eq(e.category, input.category) : undefined,
      input.from ? sql`${e.incurredOn} >= ${input.from}` : undefined,
      input.to ? sql`${e.incurredOn} <= ${input.to}` : undefined,
      input.billable === undefined ? undefined : eq(e.billable, input.billable),
      input.invoiced === undefined ? undefined : input.invoiced ? isNotNull(e.invoiceLineId) : isNull(e.invoiceLineId),
      input.q ? or(ilike(e.description, contains(input.q)), ilike(e.supplier, contains(input.q))) : undefined,
      input.cursor ? lt(e.id, input.cursor) : undefined,
    ]
    const rows = await selectExpenses(ctx).where(and(...conditions)).orderBy(desc(e.id)).limit(input.limit + 1)
    return paginate(rows.map(presentExpense), input.limit)
  },
})

export const expenseGet = defineProcedure({
  name: 'expense.get',
  summary: 'One expense',
  permission: 'expense:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: expenseOutput,
  http: { method: 'GET', path: '/expenses/{id}' },
  async handler(ctx, input) {
    return getExpense(ctx, input.id)
  },
})

const expenseFields = {
  supplier: optionalText(200),
  category: z.enum(schema.EXPENSE_CATEGORIES).optional(),
  /** Defaults to today in the organization's time zone. */
  incurredOn: z.iso.date().optional(),
  /** The project it belongs to. Its client is taken from the project. */
  projectId: z.uuid().nullish(),
  /** The client, when the expense is for one without being a project's. */
  companyId: z.uuid().nullish(),
  taxRateId: z.uuid().nullish(),
  billable: z.boolean().optional(),
  /** Added when rebilling: 15 means cost plus 15%. */
  markupPercent: percentInput.nullish(),
  notes: optionalText(10_000),
  exchangeRate: exchangeRateInput.optional(),
}

/**
 * The client an expense is for.
 *
 * A project decides it: an expense on a project is a cost of that client's
 * work, and letting the two disagree would put a cost on one client's project
 * and the rebilled line on another's invoice.
 */
async function resolveOwner(ctx: ActorContext, projectId: string | null, companyId: string | null) {
  if (projectId) {
    const project = await loadProject(ctx, projectId)
    if (companyId && companyId !== project.companyId) {
      throw new DomainError('That project is for a different client.', 'project_company_mismatch', 'companyId')
    }
    return { projectId, companyId: project.companyId }
  }
  if (companyId) await loadCompany(ctx, companyId)
  return { projectId: null, companyId }
}

/** The tax on top of the net amount, and the amount converted to the base currency. */
async function priceExpense(ctx: ActorContext, currency: string, amountMinor: number, taxRateId: string | null, exchangeRate: string | undefined) {
  const tax = await taxSnapshot(ctx, taxRateId)
  const base = await baseCurrency(ctx)
  const exchangeRateToBase = currency === base ? '1' : exchangeRate
  if (!exchangeRateToBase) {
    throw new DomainError(`Enter the exchange rate from ${currency} to ${base}.`, 'exchange_rate_required', 'exchangeRate')
  }
  return {
    ...tax,
    taxMinor: tax.taxRatePctSnapshot ? toSafeNumber(percentage(BigInt(amountMinor), tax.taxRatePctSnapshot)) : 0,
    baseCurrency: base,
    exchangeRateToBase,
    amountBaseMinor: toSafeNumber(convert(BigInt(amountMinor), currency, base, exchangeRateToBase)),
  }
}

export const expenseCreate = defineProcedure({
  name: 'expense.create',
  summary: 'Record something the agency spent',
  permission: 'expense:create',
  input: z.object({
    description: requiredText(2000, 'Description'),
    /** Net of tax. */
    amountMinor: minorAmount,
    /** Defaults to the organization's base currency. */
    currency: currencyCode.optional(),
    ...expenseFields,
  }),
  output: expenseOutput,
  http: { method: 'POST', path: '/expenses', successStatus: 201 },
  emits: ['expense.created'],
  async handler(ctx, input) {
    const owner = await resolveOwner(ctx, input.projectId ?? null, input.companyId ?? null)
    const currency = input.currency ?? (await baseCurrency(ctx))
    const id = newId()
    await ctx.tx.insert(schema.expenses).values({
      id,
      organizationId: ctx.organizationId,
      ...owner,
      description: input.description,
      supplier: input.supplier ?? null,
      category: input.category ?? 'other',
      incurredOn: input.incurredOn ?? (await today(ctx)),
      currency,
      amountMinor: input.amountMinor,
      ...(await priceExpense(ctx, currency, input.amountMinor, input.taxRateId ?? null, input.exchangeRate)),
      billable: input.billable ?? false,
      markupPercent: input.markupPercent ?? null,
      notes: input.notes ?? null,
      createdBy: actingUserId(ctx),
    })
    const expense = await getExpense(ctx, id)
    await ctx.audit({ action: 'expense.created', entityType: 'expense', entityId: id, entityLabel: expense.description })
    await ctx.emit('expense.created', expense)
    return expense
  },
})

export const expenseUpdate = defineProcedure({
  name: 'expense.update',
  summary: 'Change an expense. One already rebilled to a client cannot change.',
  permission: 'expense:update',
  input: z.object({
    id: z.uuid(),
    description: requiredText(2000, 'Description').optional(),
    amountMinor: minorAmount.optional(),
    currency: currencyCode.optional(),
    ...expenseFields,
  }),
  output: expenseOutput,
  http: { method: 'PATCH', path: '/expenses/{id}' },
  emits: ['expense.updated'],
  async handler(ctx, input) {
    const { id, exchangeRate, projectId, companyId, taxRateId, ...fields } = input
    const before = await loadChangeableExpense(ctx, id)
    const patch = provided(fields) as Partial<ExpenseRow>

    if (projectId !== undefined || companyId !== undefined) {
      Object.assign(
        patch,
        await resolveOwner(ctx, projectId !== undefined ? (projectId ?? null) : before.projectId, companyId !== undefined ? (companyId ?? null) : before.companyId),
      )
    }
    const currency = patch.currency ?? before.currency
    const amountMinor = patch.amountMinor ?? before.amountMinor
    Object.assign(
      patch,
      await priceExpense(ctx, currency, amountMinor, taxRateId !== undefined ? (taxRateId ?? null) : before.taxRateId, exchangeRate ?? before.exchangeRateToBase),
    )

    const comparable = {
      ...before,
      markupPercent: fromNumeric(before.markupPercent),
      taxRatePctSnapshot: fromNumeric(before.taxRatePctSnapshot),
      exchangeRateToBase: formatDecimal(parseDecimal(before.exchangeRateToBase, RATE_SCALE), RATE_SCALE),
    }
    const changes = diff(comparable as Record<string, unknown>, patch)
    if (!changes) return getExpense(ctx, id)

    await ctx.tx.update(schema.expenses).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.expenses.id, id))
    const expense = await getExpense(ctx, id)
    await ctx.audit({ action: 'expense.updated', entityType: 'expense', entityId: id, entityLabel: expense.description, changes })
    await ctx.emit('expense.updated', expense)
    return expense
  },
})

export const expenseDelete = defineProcedure({
  name: 'expense.delete',
  summary: 'Delete an expense. One already rebilled to a client cannot be deleted.',
  permission: 'expense:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/expenses/{id}' },
  emits: ['expense.deleted'],
  async handler(ctx, input) {
    await loadChangeableExpense(ctx, input.id)
    const expense = await getExpense(ctx, input.id)
    await ctx.tx.delete(schema.expenses).where(eq(schema.expenses.id, input.id))
    await ctx.audit({ action: 'expense.deleted', entityType: 'expense', entityId: expense.id, entityLabel: expense.description })
    await ctx.emit('expense.deleted', expense)
    return { deleted: true }
  },
})

/** Expenses rebilled by these lines become billable again when the lines go. */
export async function releaseExpenses(ctx: ActorContext, lineIds: string[]): Promise<void> {
  if (lineIds.length === 0) return
  await ctx.tx
    .update(schema.expenses)
    .set({ invoiceLineId: null, updatedAt: ctx.now })
    .where(inArray(schema.expenses.invoiceLineId, lineIds))
}

/** The client's unbilled billable expenses, oldest first, ready to be rebilled. */
export async function unbilledExpenses(
  ctx: ActorContext,
  companyId: string,
  currency: string,
  filter: { projectId?: string | undefined; from?: string | undefined; to?: string | undefined },
) {
  const e = schema.expenses
  return ctx.tx
    .select({ expense: e, projectName: schema.projects.name })
    .from(e)
    .leftJoin(schema.projects, eq(schema.projects.id, e.projectId))
    .where(
      and(
        eq(e.billable, true),
        isNull(e.invoiceLineId),
        eq(e.currency, currency),
        filter.projectId ? eq(e.projectId, filter.projectId) : eq(e.companyId, companyId),
        filter.from ? sql`${e.incurredOn} >= ${filter.from}` : undefined,
        filter.to ? sql`${e.incurredOn} <= ${filter.to}` : undefined,
      ),
    )
    .orderBy(asc(e.incurredOn), asc(e.id))
}
