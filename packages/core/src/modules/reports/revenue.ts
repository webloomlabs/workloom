import { and, eq, schema, sql } from '@workloom/db'
import { z } from 'zod'
import type { ActorContext } from '../../context.ts'
import { ratioPercent } from '../../reports/margin.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from '../crm/companies.ts'
import { today } from '../finance/documents.ts'

/**
 * Money over a period: what was billed, what came in, what is still owed, what
 * it cost, and what is left.
 *
 * **Each figure is dated the way that thing is dated**, which is the only
 * honest option: an invoice by the day it was issued, a payment by the day the
 * money moved, an expense by the day it was incurred, and time by the day it
 * was worked. They are not the same calendar, and pretending otherwise would
 * put September's work against October's invoice.
 *
 * **Outstanding is not a period figure.** What a client still owes is true now
 * or not at all, so it ignores the dates entirely and reports the position as
 * it stands.
 *
 * Per currency, and never converted, for the same reason the project view is:
 * the MVP records an exchange rate only on a document when it is issued.
 */

const monthRow = z.object({
  /** `YYYY-MM`, in the organization's time zone. */
  month: z.string(),
  billedMinor: z.number().int(),
  collectedMinor: z.number().int(),
  expenseCostMinor: z.number().int(),
  labourCostMinor: z.number().int(),
  profitMinor: z.number().int(),
})

const currencyRow = z.object({
  currency: z.string().length(3),
  /** Invoiced in the period, excluding tax. */
  billedMinor: z.number().int(),
  /** Tax charged on it, which is collected for someone else. */
  taxMinor: z.number().int(),
  /** Of `billedMinor`, the part no project claims -- see `report.projects`. */
  unattributedBilledMinor: z.number().int(),
  /** Received in the period, less refunds given in it. */
  collectedMinor: z.number().int(),
  /** Still owed as at now, whatever the period. */
  outstandingMinor: z.number().int(),
  /** Of that, past its due date. */
  overdueMinor: z.number().int(),
  expenseCostMinor: z.number().int(),
  labourCostMinor: z.number().int(),
  /** Billed less what it cost to deliver. */
  profitMinor: z.number().int(),
  profitPercent: z.string().nullable(),
  byMonth: z.array(monthRow),
})

const clientRow = z.object({
  companyId: z.uuid(),
  companyName: z.string(),
  currency: z.string().length(3),
  billedMinor: z.number().int(),
  collectedMinor: z.number().int(),
  outstandingMinor: z.number().int(),
})

/** Sums keyed by currency, then by month where a breakdown was asked for. */
type Bucket = Record<string, number>
const add = (into: Map<string, Bucket>, currency: string, key: string, value: number) => {
  const bucket = into.get(currency) ?? {}
  bucket[key] = (bucket[key] ?? 0) + value
  into.set(currency, bucket)
}

const month = (column: unknown) => sql<string>`to_char(${column}, 'YYYY-MM')`

/** The first day of the month `count` months before `date`. */
function monthsBefore(date: string, count: number): string {
  const [year, m] = date.split('-').map(Number) as [number, number]
  const shifted = (year * 12 + (m - 1)) - count
  return `${String(Math.floor(shifted / 12)).padStart(4, '0')}-${String((shifted % 12) + 1).padStart(2, '0')}-01`
}

export const reportRevenue = defineProcedure({
  name: 'report.revenue',
  summary: 'Billed, collected, outstanding, expenses, and profit over a period',
  permission: 'report:readFinancial',
  readOnly: true,
  input: z.object({
    /** Defaults to the start of the month eleven months ago. */
    from: z.iso.date().optional(),
    /** Defaults to today, in the organization's time zone. */
    to: z.iso.date().optional(),
    companyId: z.uuid().optional(),
  }),
  output: z.object({
    from: z.iso.date(),
    to: z.iso.date(),
    currencies: z.array(currencyRow),
    /** Every client with money in the period, biggest billed first. */
    byClient: z.array(clientRow),
  }),
  http: { method: 'GET', path: '/reports/revenue' },
  async handler(ctx, input) {
    if (input.companyId) await loadCompany(ctx, input.companyId)
    const to = input.to ?? (await today(ctx))
    const from = input.from ?? monthsBefore(to, 11)

    const [billed, collected, outstanding, expenses, labour, months, clients, attributed] = await Promise.all([
      billedIn(ctx, from, to, input.companyId),
      collectedIn(ctx, from, to, input.companyId),
      outstandingNow(ctx, await today(ctx), input.companyId),
      expensesIn(ctx, from, to, input.companyId),
      labourIn(ctx, from, to, input.companyId),
      monthlyIn(ctx, from, to, input.companyId),
      clientsIn(ctx, from, to, input.companyId),
      attributedIn(ctx, from, to, input.companyId),
    ])

    const currencies = new Set([...billed.keys(), ...collected.keys(), ...outstanding.keys(), ...expenses.keys(), ...labour.keys()])
    const rows = [...currencies].sort().map((currency) => {
      const billedMinor = billed.get(currency)?.net ?? 0
      const expenseCostMinor = expenses.get(currency)?.total ?? 0
      const labourCostMinor = labour.get(currency)?.total ?? 0
      const profitMinor = billedMinor - expenseCostMinor - labourCostMinor
      return {
        currency,
        billedMinor,
        taxMinor: billed.get(currency)?.tax ?? 0,
        unattributedBilledMinor: billedMinor - (attributed.get(currency)?.net ?? 0),
        collectedMinor: collected.get(currency)?.total ?? 0,
        outstandingMinor: outstanding.get(currency)?.outstanding ?? 0,
        overdueMinor: outstanding.get(currency)?.overdue ?? 0,
        expenseCostMinor,
        labourCostMinor,
        profitMinor,
        profitPercent: ratioPercent(profitMinor, billedMinor),
        byMonth: monthsFor(months, currency, from, to),
      }
    })

    return { from, to, currencies: rows, byClient: clients }
  },
})

/** Every month in the period, including the empty ones, so a chart has no gaps. */
function monthsFor(source: Map<string, Bucket>, currency: string, from: string, to: string) {
  const bucket = source.get(currency) ?? {}
  const rows: Array<z.infer<typeof monthRow>> = []
  const last = to.slice(0, 7)
  for (let cursor = from.slice(0, 7); cursor <= last; cursor = nextMonth(cursor)) {
    const billedMinor = bucket[`billed:${cursor}`] ?? 0
    const expenseCostMinor = bucket[`expense:${cursor}`] ?? 0
    const labourCostMinor = bucket[`labour:${cursor}`] ?? 0
    rows.push({
      month: cursor,
      billedMinor,
      collectedMinor: bucket[`collected:${cursor}`] ?? 0,
      expenseCostMinor,
      labourCostMinor,
      profitMinor: billedMinor - expenseCostMinor - labourCostMinor,
    })
  }
  return rows
}

function nextMonth(value: string): string {
  const [year, m] = value.split('-').map(Number) as [number, number]
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`
}

/** Invoices that are revenue: issued, and not cancelled after the fact. */
const isRevenue = () => sql`${schema.invoices.status} not in ('draft', 'cancelled')`

async function billedIn(ctx: ActorContext, from: string, to: string, companyId?: string) {
  const i = schema.invoices
  const rows = await ctx.tx
    .select({
      currency: i.currency,
      net: sql<string>`sum(${i.totalMinor} - ${i.taxMinor})`,
      tax: sql<string>`sum(${i.taxMinor})`,
    })
    .from(i)
    .where(and(isRevenue(), sql`${i.issueDate} between ${from} and ${to}`, companyId ? eq(i.companyId, companyId) : undefined))
    .groupBy(i.currency)
  const out = new Map<string, Bucket>()
  for (const row of rows) {
    add(out, row.currency, 'net', Number(row.net))
    add(out, row.currency, 'tax', Number(row.tax))
  }
  return out
}

/** The part of that revenue some project claims, so the rest can be named. */
async function attributedIn(ctx: ActorContext, from: string, to: string, companyId?: string) {
  const i = schema.invoices
  const l = schema.invoiceLines
  const rows = await ctx.tx
    .select({
      currency: i.currency,
      net: sql<string>`sum(${l.totalMinor} - ${l.taxMinor})`,
    })
    .from(l)
    .innerJoin(i, eq(i.id, l.invoiceId))
    .where(
      and(
        isRevenue(),
        sql`${i.issueDate} between ${from} and ${to}`,
        companyId ? eq(i.companyId, companyId) : undefined,
        sql`coalesce(
          (select te.project_id from time_entries te where te.invoice_line_id = ${l.id} limit 1),
          (select ex.project_id from expenses ex where ex.invoice_line_id = ${l.id} limit 1),
          ${i.projectId}
        ) is not null`,
      ),
    )
    .groupBy(i.currency)
  const out = new Map<string, Bucket>()
  for (const row of rows) add(out, row.currency, 'net', Number(row.net))
  return out
}

/** Cash in, less cash given back, by the day the money moved. */
async function collectedIn(ctx: ActorContext, from: string, to: string, companyId?: string) {
  const p = schema.payments
  const rows = await ctx.tx
    .select({
      currency: p.currency,
      total: sql<string>`sum(case when ${p.kind} = 'refund' then -${p.amountMinor} else ${p.amountMinor} end)`,
    })
    .from(p)
    .where(and(sql`${p.receivedOn} between ${from} and ${to}`, companyId ? eq(p.companyId, companyId) : undefined))
    .groupBy(p.currency)
  const out = new Map<string, Bucket>()
  for (const row of rows) add(out, row.currency, 'total', Number(row.total))
  return out
}

/** The position now, not over the period: what a client still owes today. */
async function outstandingNow(ctx: ActorContext, on: string, companyId?: string) {
  const i = schema.invoices
  const rows = await ctx.tx
    .select({
      currency: i.currency,
      outstanding: sql<string>`sum(${i.totalMinor} - ${i.amountPaidMinor})`,
      overdue: sql<string>`sum(${i.totalMinor} - ${i.amountPaidMinor}) filter (where ${i.dueDate} < ${on})`,
    })
    .from(i)
    .where(
      and(
        sql`${i.status} not in ('draft', 'cancelled', 'paid')`,
        sql`${i.totalMinor} > ${i.amountPaidMinor}`,
        companyId ? eq(i.companyId, companyId) : undefined,
      ),
    )
    .groupBy(i.currency)
  const out = new Map<string, Bucket>()
  for (const row of rows) {
    add(out, row.currency, 'outstanding', Number(row.outstanding))
    add(out, row.currency, 'overdue', Number(row.overdue ?? 0))
  }
  return out
}

async function expensesIn(ctx: ActorContext, from: string, to: string, companyId?: string) {
  const e = schema.expenses
  const rows = await ctx.tx
    .select({ currency: e.currency, total: sql<string>`sum(${e.amountMinor})` })
    .from(e)
    .where(and(sql`${e.incurredOn} between ${from} and ${to}`, companyId ? eq(e.companyId, companyId) : undefined))
    .groupBy(e.currency)
  const out = new Map<string, Bucket>()
  for (const row of rows) add(out, row.currency, 'total', Number(row.total))
  return out
}

/** Time at the cost rate each entry was logged at, rounded per entry as everywhere else. */
async function labourIn(ctx: ActorContext, from: string, to: string, companyId?: string) {
  const t = schema.timeEntries
  const rows = await ctx.tx
    .select({ currency: t.currency, total: sql<string>`coalesce(sum(round(${t.durationSeconds}::numeric * ${t.costRateMinor} / 3600)), 0)` })
    .from(t)
    .innerJoin(schema.projects, eq(schema.projects.id, t.projectId))
    .where(
      and(
        sql`${t.durationSeconds} is not null`,
        sql`${t.spentOn} between ${from} and ${to}`,
        companyId ? eq(schema.projects.companyId, companyId) : undefined,
      ),
    )
    .groupBy(t.currency)
  const out = new Map<string, Bucket>()
  for (const row of rows) add(out, row.currency, 'total', Number(row.total))
  return out
}

/** The same four figures, broken down by month, in one pass each. */
async function monthlyIn(ctx: ActorContext, from: string, to: string, companyId?: string) {
  const i = schema.invoices
  const p = schema.payments
  const e = schema.expenses
  const t = schema.timeEntries
  const out = new Map<string, Bucket>()

  const [billed, collected, expenses, labour] = await Promise.all([
    ctx.tx
      .select({ currency: i.currency, month: month(i.issueDate), total: sql<string>`sum(${i.totalMinor} - ${i.taxMinor})` })
      .from(i)
      .where(and(isRevenue(), sql`${i.issueDate} between ${from} and ${to}`, companyId ? eq(i.companyId, companyId) : undefined))
      .groupBy(i.currency, month(i.issueDate)),
    ctx.tx
      .select({
        currency: p.currency,
        month: month(p.receivedOn),
        total: sql<string>`sum(case when ${p.kind} = 'refund' then -${p.amountMinor} else ${p.amountMinor} end)`,
      })
      .from(p)
      .where(and(sql`${p.receivedOn} between ${from} and ${to}`, companyId ? eq(p.companyId, companyId) : undefined))
      .groupBy(p.currency, month(p.receivedOn)),
    ctx.tx
      .select({ currency: e.currency, month: month(e.incurredOn), total: sql<string>`sum(${e.amountMinor})` })
      .from(e)
      .where(and(sql`${e.incurredOn} between ${from} and ${to}`, companyId ? eq(e.companyId, companyId) : undefined))
      .groupBy(e.currency, month(e.incurredOn)),
    ctx.tx
      .select({
        currency: t.currency,
        month: month(t.spentOn),
        total: sql<string>`coalesce(sum(round(${t.durationSeconds}::numeric * ${t.costRateMinor} / 3600)), 0)`,
      })
      .from(t)
      .innerJoin(schema.projects, eq(schema.projects.id, t.projectId))
      .where(
        and(
          sql`${t.durationSeconds} is not null`,
          sql`${t.spentOn} between ${from} and ${to}`,
          companyId ? eq(schema.projects.companyId, companyId) : undefined,
        ),
      )
      .groupBy(t.currency, month(t.spentOn)),
  ])

  for (const row of billed) add(out, row.currency, `billed:${row.month}`, Number(row.total))
  for (const row of collected) add(out, row.currency, `collected:${row.month}`, Number(row.total))
  for (const row of expenses) add(out, row.currency, `expense:${row.month}`, Number(row.total))
  for (const row of labour) add(out, row.currency, `labour:${row.month}`, Number(row.total))
  return out
}

/** Who the money came from, biggest first. */
async function clientsIn(ctx: ActorContext, from: string, to: string, companyId?: string) {
  const i = schema.invoices
  const rows = await ctx.tx
    .select({
      companyId: i.companyId,
      companyName: schema.companies.name,
      currency: i.currency,
      billedMinor: sql<string>`sum(${i.totalMinor} - ${i.taxMinor})`,
      collectedMinor: sql<string>`sum(${i.amountPaidMinor})`,
      outstandingMinor: sql<string>`sum(${i.totalMinor} - ${i.amountPaidMinor}) filter (where ${i.status} not in ('paid'))`,
    })
    .from(i)
    .innerJoin(schema.companies, eq(schema.companies.id, i.companyId))
    .where(and(isRevenue(), sql`${i.issueDate} between ${from} and ${to}`, companyId ? eq(i.companyId, companyId) : undefined))
    .groupBy(i.companyId, schema.companies.name, i.currency)
    .orderBy(sql`sum(${i.totalMinor} - ${i.taxMinor}) desc`)
    .limit(50)
  return rows.map((row) => ({
    companyId: row.companyId,
    companyName: row.companyName,
    currency: row.currency,
    billedMinor: Number(row.billedMinor),
    collectedMinor: Number(row.collectedMinor),
    outstandingMinor: Number(row.outstandingMinor ?? 0),
  }))
}
