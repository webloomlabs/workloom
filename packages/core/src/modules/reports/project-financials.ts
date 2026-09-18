import { and, asc, desc, eq, inArray, isNull, schema, type SQL } from '@workloom/db'
import { z } from 'zod'
import type { ActorContext } from '../../context.ts'
import { budgetUsedPercent, effectiveHourlyMinor, marginPercent, utilisationPercent } from '../../reports/margin.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from '../crm/companies.ts'
import { loadProject } from '../projects/projects.ts'

/**
 * What a project earned and what it cost.
 *
 * Every figure comes from `project_financials_v` (migrations 0018 and 0025), which
 * derives them from what was stored at the time: time at the rate each entry
 * was logged at, revenue from the lines of issued invoices. Nothing here
 * recomputes a rate, which is why raising someone's pay today cannot change
 * last quarter's margin -- the guarantee the whole snapshotting design exists
 * for, and the one S8 tests directly.
 *
 * A project's P&L covers its whole life. Money over a period is a different
 * question and a different report: see `revenue.ts`.
 */

const financialsOutput = z.object({
  currency: z.string().length(3),
  /** Invoiced excluding tax. Drafts and cancelled invoices are not revenue. */
  billedMinor: z.number().int(),
  /** This project's share of what has been paid against those invoices. */
  collectedMinor: z.number().int(),
  outstandingMinor: z.number().int(),
  labourCostMinor: z.number().int(),
  expenseCostMinor: z.number().int(),
  /** The part of that cost already rebilled, and so also counted in `billedMinor`. */
  rebilledCostMinor: z.number().int(),
  /**
   * Members engaged for a fixed fee rather than by the hour. Counted once, and
   * kept out of `labourCostMinor` -- their time is logged at a cost rate of
   * zero, so the hours show without the money being counted twice.
   */
  fixedCostMinor: z.number().int(),
  membersWithFixedFee: z.number().int(),
  costMinor: z.number().int(),
  /** Billable time nobody has invoiced yet, at its billable rate. */
  uninvoicedMinor: z.number().int(),
  marginMinor: z.number().int(),
  /** Margin as a share of revenue, exact to two places. Null before anything is billed. */
  marginPercent: z.string().nullable(),
  billableSeconds: z.number().int(),
  nonBillableSeconds: z.number().int(),
  /** The billable share of tracked time. Null before any time is tracked. */
  utilisationPercent: z.string().nullable(),
  /** What an hour of tracked time earned, billable or not. Null before any time is tracked. */
  effectiveHourlyMinor: z.number().int().nullable(),
  /** Entries logged with no cost rate: time `labourCostMinor` cannot include. */
  entriesWithoutCostRate: z.number().int(),
})

export type ProjectFinancials = z.infer<typeof financialsOutput>

type ViewRow = {
  currency: string
  billedMinor: number
  collectedMinor: number
  outstandingMinor: number
  labourCostMinor: number
  expenseCostMinor: number
  rebilledCostMinor: number
  fixedCostMinor: number
  membersWithFixedFee: number
  uninvoicedMinor: number
  marginMinor: number
  billableSeconds: number
  nonBillableSeconds: number
  entriesWithoutCostRate: number
}

/** Zeros for a currency with nothing recorded in it yet, so a page can still be drawn. */
export function noFinancials(currency: string): ProjectFinancials {
  return present({
    currency,
    billedMinor: 0,
    collectedMinor: 0,
    outstandingMinor: 0,
    labourCostMinor: 0,
    expenseCostMinor: 0,
    rebilledCostMinor: 0,
    fixedCostMinor: 0,
    membersWithFixedFee: 0,
    uninvoicedMinor: 0,
    marginMinor: 0,
    billableSeconds: 0,
    nonBillableSeconds: 0,
    entriesWithoutCostRate: 0,
  })
}

function present(row: ViewRow): ProjectFinancials {
  const seconds = row.billableSeconds + row.nonBillableSeconds
  return {
    currency: row.currency,
    billedMinor: row.billedMinor,
    collectedMinor: row.collectedMinor,
    outstandingMinor: row.outstandingMinor,
    labourCostMinor: row.labourCostMinor,
    expenseCostMinor: row.expenseCostMinor,
    rebilledCostMinor: row.rebilledCostMinor,
    fixedCostMinor: row.fixedCostMinor,
    membersWithFixedFee: row.membersWithFixedFee,
    costMinor: row.labourCostMinor + row.expenseCostMinor + row.fixedCostMinor,
    uninvoicedMinor: row.uninvoicedMinor,
    marginMinor: row.marginMinor,
    marginPercent: marginPercent(row.marginMinor, row.billedMinor),
    billableSeconds: row.billableSeconds,
    nonBillableSeconds: row.nonBillableSeconds,
    utilisationPercent: utilisationPercent(row.billableSeconds, seconds),
    effectiveHourlyMinor: effectiveHourlyMinor(row.billedMinor, seconds),
    entriesWithoutCostRate: row.entriesWithoutCostRate,
  }
}

const v = schema.projectFinancials

const columns = {
  currency: v.currency,
  billedMinor: v.billedMinor,
  collectedMinor: v.collectedMinor,
  outstandingMinor: v.outstandingMinor,
  labourCostMinor: v.labourCostMinor,
  expenseCostMinor: v.expenseCostMinor,
  rebilledCostMinor: v.rebilledCostMinor,
  fixedCostMinor: v.fixedCostMinor,
  membersWithFixedFee: v.membersWithFixedFee,
  uninvoicedMinor: v.uninvoicedMinor,
  marginMinor: v.marginMinor,
  billableSeconds: v.billableSeconds,
  nonBillableSeconds: v.nonBillableSeconds,
  entriesWithoutCostRate: v.entriesWithoutCostRate,
}

/**
 * One project's rows, its own currency first.
 *
 * There is a row per currency because there is no rate to convert a time entry
 * at. A project working in one currency -- the normal case -- has exactly one.
 */
export async function financialsFor(ctx: ActorContext, projectId: string, currency: string): Promise<ProjectFinancials[]> {
  const rows = await ctx.tx.select(columns).from(v).where(eq(v.projectId, projectId))
  const found = rows.map(present)
  if (!found.some((r) => r.currency === currency)) found.push(noFinancials(currency))
  return found.sort((a, b) => (a.currency === currency ? -1 : b.currency === currency ? 1 : a.currency.localeCompare(b.currency)))
}

export const projectFinancials = defineProcedure({
  name: 'project.financials',
  summary: "A project's profit and loss: what it billed, what it cost, and what is left",
  permission: 'report:readFinancial',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: z.object({
    projectId: z.uuid(),
    name: z.string(),
    /** The project's own currency, and the first entry in `currencies`. */
    currency: z.string().length(3),
    budgetMinor: z.number().int().nullable(),
    /** What has been spent against the budget, in the project's own currency. */
    budgetUsedPercent: z.string().nullable(),
    /**
     * One entry per currency anything was recorded in, the project's own first.
     * Nothing is converted between them: the MVP records an exchange rate only
     * on a document when it is issued, and a time entry is not a document.
     */
    currencies: z.array(financialsOutput),
  }),
  http: { method: 'GET', path: '/projects/{id}/financials' },
  async handler(ctx, input) {
    const project = await loadProject(ctx, input.id)
    const currencies = await financialsFor(ctx, project.id, project.currency)
    const own = currencies[0]!
    return {
      projectId: project.id,
      name: project.name,
      currency: project.currency,
      budgetMinor: project.budgetMinor,
      budgetUsedPercent: budgetUsedPercent(own.costMinor, project.budgetMinor),
      currencies,
    }
  },
})

const portfolioRow = financialsOutput.extend({
  /** The view is per project and currency, so a project billing in two appears twice. */
  projectId: z.uuid(),
  name: z.string(),
  status: z.string(),
  companyId: z.uuid().nullable(),
  companyName: z.string().nullable(),
  budgetMinor: z.number().int().nullable(),
  budgetUsedPercent: z.string().nullable(),
})

export const reportProjects = defineProcedure({
  name: 'report.projects',
  summary: 'Every project, what it billed, what it cost, and its margin',
  permission: 'report:readFinancial',
  readOnly: true,
  input: z.object({
    companyId: z.uuid().optional(),
    status: z.enum(schema.PROJECT_STATUSES).optional(),
    /** Archived projects are left out unless asked for: their work is done. */
    includeArchived: z.union([z.boolean(), z.enum(['true', 'false']).transform((s) => s === 'true')]).default(false),
    /** `margin` is worst first -- the ones worth looking at. */
    sort: z.enum(['margin', 'billed', 'name']).default('margin'),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }),
  // A report, not a feed: it is ordered by margin, which no keyset can page on,
  // and it is read whole. `limit` is a ceiling, not a page size.
  output: z.object({ data: z.array(portfolioRow) }),
  http: { method: 'GET', path: '/reports/projects' },
  async handler(ctx, input) {
    const p = schema.projects
    if (input.companyId) await loadCompany(ctx, input.companyId)
    const conditions: Array<SQL | undefined> = [
      input.companyId ? eq(p.companyId, input.companyId) : undefined,
      input.status ? eq(p.status, input.status) : undefined,
      input.includeArchived ? undefined : isNull(p.archivedAt),
    ]

    const order = {
      margin: asc(v.marginMinor),
      billed: desc(v.billedMinor),
      name: asc(p.name),
    }[input.sort]

    const rows = await ctx.tx
      .select({
        projectId: p.id,
        name: p.name,
        status: p.status,
        companyId: p.companyId,
        companyName: schema.companies.name,
        budgetMinor: p.budgetMinor,
        ...columns,
      })
      .from(v)
      .innerJoin(p, eq(p.id, v.projectId))
      .leftJoin(schema.companies, eq(schema.companies.id, p.companyId))
      .where(and(...conditions))
      // Second key so the page boundary is stable when margins tie.
      // A second key, so the order is stable when margins tie.
      .orderBy(order, asc(v.projectId), asc(v.currency))
      .limit(input.limit)

    const data = rows.map((row) => {
      const figures = present(row)
      return {
        ...figures,
        projectId: row.projectId,
        name: row.name,
        status: row.status,
        companyId: row.companyId,
        companyName: row.companyName,
        budgetMinor: row.budgetMinor,
        budgetUsedPercent: budgetUsedPercent(figures.costMinor, row.budgetMinor),
      }
    })
    return { data }
  },
})

/** The financials of several projects at once, for a page that already has them. */
export async function financialsByProject(ctx: ActorContext, projectIds: string[]): Promise<Map<string, ProjectFinancials[]>> {
  const byProject = new Map<string, ProjectFinancials[]>()
  if (projectIds.length === 0) return byProject
  const rows = await ctx.tx.select({ projectId: v.projectId, ...columns }).from(v).where(inArray(v.projectId, projectIds))
  for (const row of rows) {
    const list = byProject.get(row.projectId) ?? []
    list.push(present(row))
    byProject.set(row.projectId, list)
  }
  return byProject
}
