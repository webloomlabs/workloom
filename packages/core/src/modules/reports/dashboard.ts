import { and, desc, eq, isNull, schema, sql } from '@workloom/db'
import { z } from 'zod'
import type { ActorContext } from '../../context.ts'
import { roundDiv } from '../../money/money.ts'
import { changePercent, PERIODS, periodRange, type PeriodRange } from '../../reports/period.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId, baseCurrency, organizationTimezone } from '../crm/shared.ts'
import { today } from '../finance/documents.ts'

/**
 * The dashboard.
 *
 * Nine figures, nine independent queries, run at once. A card the caller has no
 * permission for is never queried and comes back null rather than zero -- the
 * difference between "you may not see this" and "this is empty" matters on a
 * page whose whole job is at-a-glance truth.
 *
 * Every figure carries the same span from the period before it, so a number has
 * something to be read against. Comparison is like for like: six days into the
 * month are compared with the first six days of the last one.
 *
 * Money is in the base currency, converted only at rates that were actually
 * recorded -- each invoice, expense, and payment carries a base-currency amount
 * captured when it was written. Labour has no such amount, because a time entry
 * is not a document and no rate was ever set for it, so the profit card counts
 * time logged in the base currency and says how many hours it left out.
 */

const amountFigure = z.object({
  minor: z.number().int(),
  previousMinor: z.number().int(),
  /** Change against the same span in the period before. Null with nothing to compare to. */
  changePercent: z.string().nullable(),
})

const countFigure = z.object({
  count: z.number().int(),
  previousCount: z.number().int(),
  changePercent: z.string().nullable(),
})

const amount = (minor: number, previousMinor: number) => ({ minor, previousMinor, changePercent: changePercent(minor, previousMinor) })
const counted = (count: number, previousCount: number) => ({ count, previousCount, changePercent: changePercent(count, previousCount) })

const dashboardOutput = z.object({
  period: z.enum(PERIODS),
  from: z.iso.date(),
  to: z.iso.date(),
  previousFrom: z.iso.date(),
  previousTo: z.iso.date(),
  baseCurrency: z.string().length(3),

  /** Null without `report:readFinancial`. */
  money: z
    .object({
      /** Invoiced in the period, excluding tax. */
      revenue: amountFigure,
      /** Owed as things stand, whatever the period. */
      outstanding: z.object({
        minor: z.number().int(),
        count: z.number().int(),
        overdueMinor: z.number().int(),
        overdueCount: z.number().int(),
      }),
      expenses: amountFigure,
      /** Revenue less expenses and the time it took. */
      profit: amountFigure.extend({
        labourCostMinor: z.number().int(),
        /** Time this could not cost, because it was logged in another currency. */
        uncountedSeconds: z.number().int(),
        uncountedCurrencies: z.array(z.string().length(3)),
      }),
    })
    .nullable(),

  /** Null without `project:read`. */
  projects: z
    .object({
      /** How many are live now. A position, not a flow, so nothing to compare it against. */
      active: z.number().int(),
      onHold: z.number().int(),
      overdue: z.number().int(),
      /** Finished in the period: this one is a flow, and does compare. */
      completed: countFigure,
    })
    .nullable(),

  /** Null without `task:read`. */
  tasks: z.object({ open: z.number().int(), overdue: z.number().int(), mine: z.number().int(), completed: countFigure }).nullable(),

  /** What falls due in the next fortnight. Null without `task:read`. */
  deadlines: z
    .array(
      z.object({
        kind: z.enum(['task', 'milestone']),
        id: z.uuid(),
        title: z.string(),
        dueDate: z.iso.date(),
        projectId: z.uuid(),
        projectName: z.string(),
        overdue: z.boolean(),
      }),
    )
    .nullable(),

  /** Null without `lead:read`. */
  leads: z.object({ open: z.number().int(), created: countFigure, converted: countFigure }).nullable(),

  /**
   * Open deal value, per currency, base currency first. A deal records a value
   * and a currency and never an exchange rate, so nothing is converted.
   * Null without `deal:read`.
   */
  pipeline: z
    .array(z.object({ currency: z.string().length(3), openMinor: z.number().int(), openCount: z.number().int(), wonMinor: z.number().int(), wonCount: z.number().int() }))
    .nullable(),

  /** What has happened lately. Null without `auditLog:read`. */
  activity: z
    .array(z.object({ id: z.uuid(), action: z.string(), entityType: z.string(), entityLabel: z.string().nullable(), actorLabel: z.string().nullable(), at: z.date() }))
    .nullable(),
})

export type Dashboard = z.infer<typeof dashboardOutput>

/**
 * A document's amount in the base currency, from the rate recorded on it.
 *
 * The document stores its gross total and that total converted. Any part of it
 * -- the net of tax, the part still unpaid -- is that same proportion of the
 * converted figure. One rounding per currency, and none at all when the
 * document is already in the base currency, which is the usual case.
 */
function inBase(part: number, gross: number, base: number): number {
  if (gross === 0) return 0
  if (part === gross) return base
  return Number(roundDiv(BigInt(base) * BigInt(part), BigInt(gross)))
}

const num = (value: unknown) => Number(value ?? 0)

/** A calendar date from a timestamp, as the organization reckons it. */
const dateAt = (column: unknown, timezone: string) => sql`((${column} at time zone ${timezone})::date)`

const within = (expression: unknown, from: string, to: string) => sql`${expression} between ${from} and ${to}`

export const dashboardGet = defineProcedure({
  name: 'dashboard.get',
  summary: 'The nine headline figures, each against the same span in the period before',
  // Everyone may open the dashboard; each card is gated on its own reading.
  permission: 'report:read',
  readOnly: true,
  input: z.object({ period: z.enum(PERIODS).default('month') }),
  output: dashboardOutput,
  http: { method: 'GET', path: '/dashboard' },
  async handler(ctx, input) {
    const [now, timezone, base] = await Promise.all([today(ctx), organizationTimezone(ctx), baseCurrency(ctx)])
    const range = periodRange(input.period, now)

    const [money, projects, tasks, deadlines, leads, pipeline, activity] = await Promise.all([
      ctx.has('report:readFinancial') ? moneyCards(ctx, range, now, base) : null,
      ctx.has('project:read') ? projectCards(ctx, range, now, timezone) : null,
      ctx.has('task:read') ? taskCards(ctx, range, now, timezone) : null,
      ctx.has('task:read') ? dueSoon(ctx, now) : null,
      ctx.has('lead:read') ? leadCards(ctx, range, timezone) : null,
      ctx.has('deal:read') ? pipelineCards(ctx, range, base, timezone) : null,
      ctx.has('auditLog:read') ? recentActivity(ctx) : null,
    ])

    return { period: input.period, ...range, baseCurrency: base, money, projects, tasks, deadlines, leads, pipeline, activity }
  },
})

/** Revenue, outstanding, expenses, and what is left. Four queries, run together. */
async function moneyCards(ctx: ActorContext, range: PeriodRange, now: string, base: string): Promise<Dashboard['money']> {
  const i = schema.invoices
  const e = schema.expenses
  const t = schema.timeEntries
  const issued = sql`${i.status} not in ('draft', 'cancelled')`
  const inNow = (column: unknown) => within(column, range.from, range.to)
  const inPrevious = (column: unknown) => within(column, range.previousFrom, range.previousTo)

  const [invoiced, owed, spent, worked] = await Promise.all([
    // Grouped by currency so each can be converted at its own recorded rate.
    ctx.tx
      .select({
        currency: i.currency,
        netNow: sql<string>`coalesce(sum(${i.totalMinor} - ${i.taxMinor}) filter (where ${inNow(i.issueDate)}), 0)`,
        grossNow: sql<string>`coalesce(sum(${i.totalMinor}) filter (where ${inNow(i.issueDate)}), 0)`,
        baseNow: sql<string>`coalesce(sum(${i.totalBaseMinor}) filter (where ${inNow(i.issueDate)}), 0)`,
        netThen: sql<string>`coalesce(sum(${i.totalMinor} - ${i.taxMinor}) filter (where ${inPrevious(i.issueDate)}), 0)`,
        grossThen: sql<string>`coalesce(sum(${i.totalMinor}) filter (where ${inPrevious(i.issueDate)}), 0)`,
        baseThen: sql<string>`coalesce(sum(${i.totalBaseMinor}) filter (where ${inPrevious(i.issueDate)}), 0)`,
      })
      .from(i)
      .where(and(issued, within(i.issueDate, range.previousFrom, range.to)))
      .groupBy(i.currency),

    ctx.tx
      .select({
        currency: i.currency,
        due: sql<string>`sum(${i.totalMinor} - ${i.amountPaidMinor})`,
        gross: sql<string>`sum(${i.totalMinor})`,
        base: sql<string>`sum(${i.totalBaseMinor})`,
        n: sql<number>`count(*)::int`,
        overdueDue: sql<string>`coalesce(sum(${i.totalMinor} - ${i.amountPaidMinor}) filter (where ${i.dueDate} < ${now}), 0)`,
        overdueGross: sql<string>`coalesce(sum(${i.totalMinor}) filter (where ${i.dueDate} < ${now}), 0)`,
        overdueBase: sql<string>`coalesce(sum(${i.totalBaseMinor}) filter (where ${i.dueDate} < ${now}), 0)`,
        overdueN: sql<number>`count(*) filter (where ${i.dueDate} < ${now})::int`,
      })
      .from(i)
      .where(and(sql`${i.status} not in ('draft', 'cancelled', 'paid')`, sql`${i.totalMinor} > ${i.amountPaidMinor}`))
      .groupBy(i.currency),

    // Expenses store their net amount already converted, so no apportioning.
    ctx.tx
      .select({
        now: sql<string>`coalesce(sum(${e.amountBaseMinor}) filter (where ${inNow(e.incurredOn)}), 0)`,
        then: sql<string>`coalesce(sum(${e.amountBaseMinor}) filter (where ${inPrevious(e.incurredOn)}), 0)`,
      })
      .from(e)
      .where(within(e.incurredOn, range.previousFrom, range.to)),

    ctx.tx
      .select({
        currency: t.currency,
        now: sql<string>`coalesce(sum(round(${t.durationSeconds}::numeric * ${t.costRateMinor} / 3600)) filter (where ${inNow(t.spentOn)}), 0)`,
        then: sql<string>`coalesce(sum(round(${t.durationSeconds}::numeric * ${t.costRateMinor} / 3600)) filter (where ${inPrevious(t.spentOn)}), 0)`,
        seconds: sql<number>`coalesce(sum(${t.durationSeconds}) filter (where ${inNow(t.spentOn)}), 0)::int`,
      })
      .from(t)
      .where(and(sql`${t.durationSeconds} is not null`, within(t.spentOn, range.previousFrom, range.to)))
      .groupBy(t.currency),
  ])

  let revenueNow = 0
  let revenueThen = 0
  for (const row of invoiced) {
    revenueNow += inBase(num(row.netNow), num(row.grossNow), num(row.baseNow))
    revenueThen += inBase(num(row.netThen), num(row.grossThen), num(row.baseThen))
  }

  let outstandingMinor = 0
  let overdueMinor = 0
  let outstandingCount = 0
  let overdueCount = 0
  for (const row of owed) {
    outstandingMinor += inBase(num(row.due), num(row.gross), num(row.base))
    overdueMinor += inBase(num(row.overdueDue), num(row.overdueGross), num(row.overdueBase))
    outstandingCount += row.n
    overdueCount += row.overdueN
  }

  const expensesNow = num(spent[0]?.now)
  const expensesThen = num(spent[0]?.then)

  // Only time logged in the base currency can be costed: nothing recorded a
  // rate for the rest, and inventing one on a profit card would be a lie.
  let labourNow = 0
  let labourThen = 0
  let uncountedSeconds = 0
  const uncountedCurrencies: string[] = []
  for (const row of worked) {
    if (row.currency === base) {
      labourNow += num(row.now)
      labourThen += num(row.then)
    } else if (row.seconds > 0) {
      uncountedSeconds += row.seconds
      uncountedCurrencies.push(row.currency)
    }
  }

  return {
    revenue: amount(revenueNow, revenueThen),
    outstanding: { minor: outstandingMinor, count: outstandingCount, overdueMinor, overdueCount },
    expenses: amount(expensesNow, expensesThen),
    profit: {
      ...amount(revenueNow - expensesNow - labourNow, revenueThen - expensesThen - labourThen),
      labourCostMinor: labourNow,
      uncountedSeconds,
      uncountedCurrencies: uncountedCurrencies.sort(),
    },
  }
}

async function projectCards(ctx: ActorContext, range: PeriodRange, now: string, timezone: string): Promise<Dashboard['projects']> {
  const p = schema.projects
  const completedOn = dateAt(p.completedAt, timezone)
  const [row] = await ctx.tx
    .select({
      active: sql<number>`count(*) filter (where ${p.status} in ('planning', 'in_progress', 'review'))::int`,
      onHold: sql<number>`count(*) filter (where ${p.status} = 'on_hold')::int`,
      overdue: sql<number>`count(*) filter (where ${p.dueDate} < ${now} and ${p.status} not in ('completed', 'cancelled'))::int`,
      completedNow: sql<number>`count(*) filter (where ${within(completedOn, range.from, range.to)})::int`,
      completedThen: sql<number>`count(*) filter (where ${within(completedOn, range.previousFrom, range.previousTo)})::int`,
    })
    .from(p)
    .where(isNull(p.archivedAt))

  return {
    active: row?.active ?? 0,
    onHold: row?.onHold ?? 0,
    overdue: row?.overdue ?? 0,
    completed: counted(row?.completedNow ?? 0, row?.completedThen ?? 0),
  }
}

async function taskCards(ctx: ActorContext, range: PeriodRange, now: string, timezone: string): Promise<Dashboard['tasks']> {
  const t = schema.tasks
  const open = sql`${t.status} not in ('done', 'cancelled')`
  const completedOn = dateAt(t.completedAt, timezone)
  const me = actingUserId(ctx)
  const [row] = await ctx.tx
    .select({
      open: sql<number>`count(*) filter (where ${open})::int`,
      overdue: sql<number>`count(*) filter (where ${open} and ${t.dueDate} < ${now})::int`,
      mine: me ? sql<number>`count(*) filter (where ${open} and ${t.assigneeId} = ${me})::int` : sql<number>`0::int`,
      completedNow: sql<number>`count(*) filter (where ${within(completedOn, range.from, range.to)})::int`,
      completedThen: sql<number>`count(*) filter (where ${within(completedOn, range.previousFrom, range.previousTo)})::int`,
    })
    .from(t)
    .innerJoin(schema.projects, eq(schema.projects.id, t.projectId))
    .where(isNull(schema.projects.archivedAt))

  return {
    open: row?.open ?? 0,
    overdue: row?.overdue ?? 0,
    mine: row?.mine ?? 0,
    completed: counted(row?.completedNow ?? 0, row?.completedThen ?? 0),
  }
}

/** Tasks and milestones falling due in the next fortnight, and anything already late. */
const DEADLINE_HORIZON_DAYS = 14

async function dueSoon(ctx: ActorContext, now: string): Promise<Dashboard['deadlines']> {
  const horizon = new Date(`${now}T00:00:00Z`)
  horizon.setUTCDate(horizon.getUTCDate() + DEADLINE_HORIZON_DAYS)
  const until = horizon.toISOString().slice(0, 10)

  const { rows } = await ctx.tx.execute<{
    kind: 'task' | 'milestone'
    id: string
    title: string
    due_date: string
    project_id: string
    project_name: string
  }>(sql`
    select 'task' as kind, t.id, t.title, t.due_date, t.project_id, p.name as project_name
      from tasks t join projects p on p.id = t.project_id
     where p.archived_at is null and t.status not in ('done', 'cancelled')
       and t.due_date is not null and t.due_date <= ${until}
    union all
    select 'milestone' as kind, m.id, m.name as title, m.due_date, m.project_id, p.name as project_name
      from milestones m join projects p on p.id = m.project_id
     where p.archived_at is null and m.completed_at is null
       and m.due_date is not null and m.due_date <= ${until}
     order by due_date, title
     limit 10
  `)

  return rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    title: row.title,
    dueDate: row.due_date,
    projectId: row.project_id,
    projectName: row.project_name,
    overdue: row.due_date < now,
  }))
}

async function leadCards(ctx: ActorContext, range: PeriodRange, timezone: string): Promise<Dashboard['leads']> {
  const l = schema.leads
  const createdOn = dateAt(l.createdAt, timezone)
  const convertedOn = dateAt(l.convertedAt, timezone)
  const [row] = await ctx.tx
    .select({
      open: sql<number>`count(*) filter (where ${l.status} in ('new', 'contacted', 'qualified'))::int`,
      createdNow: sql<number>`count(*) filter (where ${within(createdOn, range.from, range.to)})::int`,
      createdThen: sql<number>`count(*) filter (where ${within(createdOn, range.previousFrom, range.previousTo)})::int`,
      convertedNow: sql<number>`count(*) filter (where ${within(convertedOn, range.from, range.to)})::int`,
      convertedThen: sql<number>`count(*) filter (where ${within(convertedOn, range.previousFrom, range.previousTo)})::int`,
    })
    .from(l)
    .where(isNull(l.archivedAt))

  return {
    open: row?.open ?? 0,
    created: counted(row?.createdNow ?? 0, row?.createdThen ?? 0),
    converted: counted(row?.convertedNow ?? 0, row?.convertedThen ?? 0),
  }
}

async function pipelineCards(ctx: ActorContext, range: PeriodRange, base: string, timezone: string): Promise<Dashboard['pipeline']> {
  const d = schema.deals
  const closedOn = dateAt(d.closedAt, timezone)
  const rows = await ctx.tx
    .select({
      currency: d.currency,
      openMinor: sql<string>`coalesce(sum(${d.valueMinor}) filter (where ${d.stage} in ('qualified', 'proposal_sent', 'negotiation')), 0)`,
      openCount: sql<number>`count(*) filter (where ${d.stage} in ('qualified', 'proposal_sent', 'negotiation'))::int`,
      wonMinor: sql<string>`coalesce(sum(${d.valueMinor}) filter (where ${d.stage} = 'won' and ${within(closedOn, range.from, range.to)}), 0)`,
      wonCount: sql<number>`count(*) filter (where ${d.stage} = 'won' and ${within(closedOn, range.from, range.to)})::int`,
    })
    .from(d)
    .where(isNull(d.archivedAt))
    .groupBy(d.currency)

  return rows
    .map((row) => ({ currency: row.currency, openMinor: num(row.openMinor), openCount: row.openCount, wonMinor: num(row.wonMinor), wonCount: row.wonCount }))
    .filter((row) => row.openCount > 0 || row.wonCount > 0)
    .sort((a, b) => (a.currency === base ? -1 : b.currency === base ? 1 : a.currency.localeCompare(b.currency)))
}

const ACTIVITY_LIMIT = 12

async function recentActivity(ctx: ActorContext): Promise<Dashboard['activity']> {
  const a = schema.auditLogs
  const rows = await ctx.tx
    .select({ id: a.id, action: a.action, entityType: a.entityType, entityLabel: a.entityLabel, actorLabel: a.actorLabel, at: a.createdAt })
    .from(a)
    .orderBy(desc(a.id))
    .limit(ACTIVITY_LIMIT)
  return rows
}
