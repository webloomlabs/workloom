import { and, asc, eq, inArray, schema, sql } from '@workloom/db'
import { z } from 'zod'
import { DomainError, type ActorContext } from '../../context.ts'
import { fiscalYearOf, fiscalYearStarting, type FiscalYear } from '../../reports/fiscal.ts'
import type { PackExpense, PackInput, PackInvoice, PackPayment, TaxTreatment } from '../../reports/tax-pack.ts'
import { defineProcedure } from '../../registry/index.ts'
import { requiredText } from '../crm/shared.ts'
import { expenseBaseCostSql, countsAsCost } from '../finance/expense-cost.ts'
import { today } from '../finance/documents.ts'

/**
 * Closing the books: the lock date, and the year's figures that a tax pack is
 * made of.
 *
 * Locking says "these figures are final": invoices issued, payments received,
 * and expenses incurred on or before the date can no longer be added, changed,
 * or removed. The database enforces it (migration 0044); the procedures here
 * only move the date, and say why in the audit log.
 */

async function organization(ctx: ActorContext) {
  const [org] = await ctx.tx
    .select({
      name: schema.organization.name,
      legalName: schema.organization.legalName,
      baseCurrency: schema.organization.baseCurrency,
      fiscalYearStartMonth: schema.organization.fiscalYearStartMonth,
      booksLockedThrough: schema.organization.booksLockedThrough,
    })
    .from(schema.organization)
    .where(eq(schema.organization.id, ctx.organizationId))
    .limit(1)
  return org!
}

const yearOutput = z.object({ startYear: z.number().int(), from: z.iso.date(), to: z.iso.date(), label: z.string() })

const booksOutput = z.object({
  booksLockedThrough: z.iso.date().nullable(),
  /** The organization's currency, which the books are kept in. */
  currency: z.string().length(3),
  /** Today, in the organization's time zone. */
  today: z.iso.date(),
  fiscalYearStartMonth: z.number().int(),
  /** The financial year today is in, and the ones before it that can be packed. */
  currentYear: yearOutput,
  years: z.array(yearOutput),
})

async function presentBooks(ctx: ActorContext) {
  const org = await organization(ctx)
  const day = await today(ctx)
  const current = fiscalYearOf(day, org.fiscalYearStartMonth)
  const years = Array.from({ length: 6 }, (_, i) => fiscalYearStarting(current.startYear - i, org.fiscalYearStartMonth))
  const pick = (y: FiscalYear) => ({ startYear: y.startYear, from: y.from, to: y.to, label: y.label })
  return { booksLockedThrough: org.booksLockedThrough, currency: org.baseCurrency, today: day, fiscalYearStartMonth: org.fiscalYearStartMonth, currentYear: pick(current), years: years.map(pick) }
}

export const booksGet = defineProcedure({
  name: 'books.get',
  summary: 'Where the books are locked, and the financial years',
  permission: 'report:readFinancial',
  readOnly: true,
  input: z.object({}),
  output: booksOutput,
  http: { method: 'GET', path: '/books' },
  async handler(ctx) {
    return presentBooks(ctx)
  },
})

export const booksLock = defineProcedure({
  name: 'books.lock',
  summary: 'Close the books through a day: nothing dated on or before it can be added, changed, or removed',
  permission: 'books:lock',
  input: z.object({ through: z.iso.date(), reason: requiredText(500, 'Reason') }),
  output: booksOutput,
  http: { method: 'POST', path: '/books/lock' },
  emits: [],
  async handler(ctx, input) {
    const org = await organization(ctx)
    if (input.through > (await today(ctx))) throw new DomainError('The books can be closed only up to today.', 'lock_in_future', 'through')
    if (org.booksLockedThrough && input.through <= org.booksLockedThrough) {
      throw new DomainError(`The books are already closed through ${org.booksLockedThrough}. Reopen them to move the date back.`, 'already_locked', 'through')
    }
    await ctx.tx.update(schema.organization).set({ booksLockedThrough: input.through }).where(eq(schema.organization.id, ctx.organizationId))
    await ctx.audit({
      action: 'books.locked',
      entityType: 'organization',
      entityId: ctx.organizationId,
      entityLabel: input.reason,
      changes: { booksLockedThrough: { from: org.booksLockedThrough, to: input.through } },
    })
    return presentBooks(ctx)
  },
})

export const booksUnlock = defineProcedure({
  name: 'books.unlock',
  // Not offered to AI assistants: Reopening a closed period is an accountant’s decision.
  mcp: false,
  summary: 'Reopen the books, entirely or back to an earlier day. The reason is kept in the audit log.',
  permission: 'books:lock',
  input: z.object({ to: z.iso.date().nullish(), reason: requiredText(500, 'Reason') }),
  output: booksOutput,
  http: { method: 'POST', path: '/books/unlock' },
  emits: [],
  async handler(ctx, input) {
    const org = await organization(ctx)
    if (!org.booksLockedThrough) throw new DomainError('The books are not closed.', 'not_locked')
    const to = input.to ?? null
    if (to && to >= org.booksLockedThrough) throw new DomainError(`Reopening moves the date back, before ${org.booksLockedThrough}.`, 'not_earlier', 'to')
    await ctx.tx.update(schema.organization).set({ booksLockedThrough: to }).where(eq(schema.organization.id, ctx.organizationId))
    await ctx.audit({
      action: 'books.unlocked',
      entityType: 'organization',
      entityId: ctx.organizationId,
      entityLabel: input.reason,
      changes: { booksLockedThrough: { from: org.booksLockedThrough, to } },
    })
    return presentBooks(ctx)
  },
})

/** The year a request names, by the calendar year it starts in. */
export async function yearFor(ctx: ActorContext, startYear: number): Promise<FiscalYear> {
  return fiscalYearStarting(startYear, (await organization(ctx)).fiscalYearStartMonth)
}

/** Everything a tax pack is made of, for one financial year. Receipts are listed, not fetched. */
export async function collectPackInput(ctx: ActorContext, year: FiscalYear, now: Date): Promise<PackInput> {
  const org = await organization(ctx)
  const i = schema.invoices
  const e = schema.expenses
  const p = schema.payments
  const inYear = (column: unknown) => sql`${column} between ${year.from} and ${year.to}`

  const invoices = await ctx.tx
    .select({
      number: i.number,
      issueDate: i.issueDate,
      client: schema.companies.name,
      currency: i.currency,
      totalMinor: i.totalMinor,
      taxMinor: i.taxMinor,
      exchangeRateToBase: i.exchangeRateToBase,
      status: i.status,
    })
    .from(i)
    .innerJoin(schema.companies, eq(schema.companies.id, i.companyId))
    .where(and(sql`${i.status} not in ('draft', 'cancelled')`, inYear(i.issueDate)))
    .orderBy(asc(i.issueDate), asc(i.number))

  const [drafts] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(i)
    .where(and(eq(i.status, 'draft'), sql`coalesce(${i.issueDate}, (${i.createdAt} at time zone 'UTC')::date) between ${year.from} and ${year.to}`))

  const expenseRows = await ctx.tx
    .select({
      id: e.id,
      number: e.number,
      incurredOn: e.incurredOn,
      supplier: e.supplier,
      description: e.description,
      category: e.category,
      categoryName: schema.expenseCategories.name,
      treatment: schema.expenseCategories.taxTreatment,
      currency: e.currency,
      amountMinor: e.amountMinor,
      taxMinor: e.taxMinor,
      costBaseMinor: sql<string>`${expenseBaseCostSql}`,
      project: schema.projects.name,
    })
    .from(e)
    .innerJoin(schema.expenseCategories, and(eq(schema.expenseCategories.organizationId, e.organizationId), eq(schema.expenseCategories.key, e.category)))
    .leftJoin(schema.projects, eq(schema.projects.id, e.projectId))
    .where(and(countsAsCost, inYear(e.incurredOn)))
    .orderBy(asc(e.incurredOn), asc(e.number))

  const receipts = expenseRows.length
    ? await ctx.tx
        .select({ expenseId: schema.expenseReceipts.expenseId, filename: schema.expenseReceipts.filename, storageKey: schema.expenseReceipts.storageKey, contentType: schema.expenseReceipts.contentType })
        .from(schema.expenseReceipts)
        .where(inArray(schema.expenseReceipts.expenseId, expenseRows.map((r) => r.id)))
        .orderBy(asc(schema.expenseReceipts.createdAt))
    : []

  const [draftExpenses] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(e)
    .where(and(eq(e.status, 'draft'), inYear(e.incurredOn)))

  const paymentRows = await ctx.tx
    .select({
      receivedOn: p.receivedOn,
      client: schema.companies.name,
      method: p.method,
      reference: p.reference,
      currency: p.currency,
      kind: p.kind,
      amountMinor: p.amountMinor,
      amountBaseMinor: p.amountBaseMinor,
      invoices: sql<string>`coalesce((select string_agg(inv.number, ' ' order by inv.number) from payment_allocations a join invoices inv on inv.id = a.invoice_id where a.payment_id = ${p.id}), '')`,
    })
    .from(p)
    .innerJoin(schema.companies, eq(schema.companies.id, p.companyId))
    .where(inYear(p.receivedOn))
    .orderBy(asc(p.receivedOn))

  const expenses: PackExpense[] = expenseRows.map((r) => ({
    number: r.number,
    incurredOn: r.incurredOn,
    supplier: r.supplier,
    description: r.description,
    category: r.category,
    categoryName: r.categoryName,
    treatment: r.treatment as TaxTreatment,
    currency: r.currency,
    amountMinor: r.amountMinor,
    taxMinor: r.taxMinor,
    costBaseMinor: Number(r.costBaseMinor),
    project: r.project,
    receipts: receipts.filter((x) => x.expenseId === r.id),
  }))

  const payments: PackPayment[] = paymentRows.map((r) => {
    // A refund is money going back: it counts against what was received.
    const sign = r.kind === 'refund' ? -1 : 1
    return { receivedOn: r.receivedOn, client: r.client, method: r.method, reference: r.reference, currency: r.currency, amountMinor: sign * r.amountMinor, amountBaseMinor: sign * r.amountBaseMinor, invoices: r.invoices }
  })

  return {
    organization: org.legalName || org.name,
    baseCurrency: org.baseCurrency,
    year: { label: year.label, from: year.from, to: year.to },
    invoices: invoices.map((r): PackInvoice => ({ ...r, number: r.number ?? '', issueDate: r.issueDate ?? '' })),
    expenses,
    payments,
    draftInvoices: drafts?.n ?? 0,
    draftExpenses: draftExpenses?.n ?? 0,
    booksLockedThrough: org.booksLockedThrough,
    generatedAt: now.toISOString(),
  }
}
