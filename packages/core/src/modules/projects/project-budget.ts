import { and, eq, isNull, schema, sql } from '@workloom/db'
import { z } from 'zod'
import { type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { dateIn } from '../../time/index.ts'
import { organizationTimezone } from '../crm/shared.ts'
import { countsAsCost, expenseCostSql } from '../finance/expense-cost.ts'
import { budgetStatus, budgetWindow, estimatedHours, type BudgetPeriod } from './budget.ts'
import { loadProject } from './projects.ts'

/**
 * A project's cost and time against its budget, for the budget period that
 * contains a day: the whole project for a build, this month for a retainer.
 *
 * Cost is what the project's own figures say elsewhere: time at the cost rate
 * each entry was logged at, confirmed expenses (with tax where it is not
 * reclaimed), and fixed member fees -- those only against a whole-project
 * budget, since a fee for the engagement does not belong to any one month.
 */

export const projectBudgetOutput = z.object({
  projectId: z.uuid(),
  projectName: z.string(),
  currency: z.string().length(3),
  billingModel: z.enum(schema.PROJECT_BILLING_MODELS),
  period: z.enum(schema.BUDGET_PERIODS),
  /** The budget period measured, inclusive; null for a whole-project budget. */
  window: z.object({ from: z.iso.date(), to: z.iso.date() }).nullable(),
  budgetMinor: z.number().int().nullable(),
  costMinor: z.number().int(),
  labourCostMinor: z.number().int(),
  expenseCostMinor: z.number().int(),
  fixedCostMinor: z.number().int(),
  /** The hours budget measured against: the project's own, or its tasks' estimates for a whole-project budget. */
  budgetHours: z.number().nullable(),
  /** Where `budgetHours` came from. */
  hoursSource: z.enum(['budget', 'estimates', 'none']),
  loggedHours: z.number(),
  estimatedHours: z.number().nullable(),
  costPercent: z.number().int().nullable(),
  hoursPercent: z.number().int().nullable(),
  level: z.enum(['none', 'ok', 'warning', 'over']),
})

export type ProjectBudget = z.infer<typeof projectBudgetOutput>

type ProjectRow = Awaited<ReturnType<typeof loadProject>>

const hours = (seconds: number) => Math.round((seconds / 3600) * 100) / 100

export async function computeBudget(ctx: ActorContext, project: ProjectRow, today: string): Promise<ProjectBudget> {
  const period = project.budgetPeriod as BudgetPeriod
  const window = budgetWindow(period, today)
  const within = (column: unknown) => (window ? sql`${column} between ${window.from} and ${window.to}` : undefined)
  const t = schema.timeEntries
  const e = schema.expenses

  const [[labour], [spent], [fixed], tasks] = await Promise.all([
    ctx.tx
      .select({
        cost: sql<string>`coalesce(sum(round(${t.durationSeconds}::numeric * coalesce(${t.costRateMinor}, 0) / 3600)), 0)`,
        seconds: sql<string>`coalesce(sum(${t.durationSeconds}), 0)`,
      })
      .from(t)
      .where(and(eq(t.projectId, project.id), sql`${t.durationSeconds} is not null`, within(t.spentOn))),
    ctx.tx
      .select({ cost: sql<string>`coalesce(sum(${expenseCostSql}), 0)` })
      .from(e)
      .where(and(eq(e.projectId, project.id), countsAsCost, eq(e.currency, project.currency), within(e.incurredOn))),
    window
      ? Promise.resolve([{ fee: '0' }])
      : ctx.tx
          .select({ fee: sql<string>`coalesce(sum(${schema.projectMembers.fixedFeeMinor}), 0)` })
          .from(schema.projectMembers)
          .where(eq(schema.projectMembers.projectId, project.id)),
    ctx.tx.select({ estimateMinutes: schema.tasks.estimateMinutes, status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.projectId, project.id)),
  ])

  const labourCostMinor = Number(labour?.cost ?? 0)
  const expenseCostMinor = Number(spent?.cost ?? 0)
  const fixedCostMinor = Number(fixed?.fee ?? 0)
  const loggedSeconds = Number(labour?.seconds ?? 0)
  const estimate = estimatedHours(tasks)
  const ownHours = project.budgetHours === null ? null : Number(project.budgetHours)
  const budgetHours = ownHours ?? (window ? null : estimate)
  const costMinor = labourCostMinor + expenseCostMinor + fixedCostMinor
  const status = budgetStatus({ budgetMinor: project.budgetMinor, costMinor, budgetHours, loggedSeconds })

  return {
    projectId: project.id,
    projectName: project.name,
    currency: project.currency,
    billingModel: project.billingModel as ProjectBudget['billingModel'],
    period,
    window,
    budgetMinor: project.budgetMinor,
    costMinor,
    labourCostMinor,
    expenseCostMinor,
    fixedCostMinor,
    budgetHours,
    hoursSource: ownHours !== null ? 'budget' : budgetHours !== null ? 'estimates' : 'none',
    loggedHours: hours(loggedSeconds),
    estimatedHours: estimate,
    costPercent: status.costPercent,
    hoursPercent: status.hoursPercent,
    level: status.level,
  }
}

async function todayFor(ctx: ActorContext): Promise<string> {
  return dateIn(ctx.now, await organizationTimezone(ctx))
}

export const projectBudget = defineProcedure({
  name: 'project.budget',
  summary: "A project's cost and hours against its budget, for the budget period that contains a day (today by default)",
  permission: 'project:read',
  readOnly: true,
  input: z.object({ id: z.uuid(), on: z.iso.date().optional() }),
  output: projectBudgetOutput,
  http: { method: 'GET', path: '/projects/{id}/budget' },
  async handler(ctx, input) {
    // A budget is a commercial term: reading one needs the financial view.
    ctx.require('report:readFinancial')
    const project = await loadProject(ctx, input.id)
    return computeBudget(ctx, project, input.on ?? (await todayFor(ctx)))
  },
})

/** Active projects that have a budget of either kind -- money, hours, or task estimates. */
async function budgetedProjects(ctx: ActorContext) {
  const p = schema.projects
  return ctx.tx
    .select()
    .from(p)
    .where(
      and(
        isNull(p.archivedAt),
        sql`${p.status} not in ('completed', 'cancelled')`,
        sql`(${p.budgetMinor} is not null or ${p.budgetHours} is not null or (${p.budgetPeriod} = 'total' and exists (select 1 from tasks t where t.project_id = ${p.id} and t.estimate_minutes is not null)))`,
      ),
    )
    .limit(1000)
}

const LEVEL_ORDER = { over: 0, warning: 1, ok: 2, none: 3 } as const

export const reportProjectBudgets = defineProcedure({
  name: 'report.projectBudgets',
  summary: 'Every active project with a budget, the ones at risk first',
  permission: 'report:readFinancial',
  readOnly: true,
  input: z.object({ atRisk: z.boolean().optional() }),
  output: z.object({ data: z.array(projectBudgetOutput) }),
  http: { method: 'GET', path: '/reports/project-budgets' },
  async handler(ctx, input) {
    const today = await todayFor(ctx)
    const budgets = await Promise.all((await budgetedProjects(ctx)).map((p) => computeBudget(ctx, p, today)))
    const worst = (b: ProjectBudget) => Math.max(b.costPercent ?? -1, b.hoursPercent ?? -1)
    return {
      data: budgets
        .filter((b) => !input.atRisk || b.level === 'warning' || b.level === 'over')
        .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || worst(b) - worst(a)),
    }
  },
})

/**
 * Records each budget threshold an active project has crossed this period,
 * once, and announces it: an event, an audit entry, and an email to the
 * project's owner. Run hourly by the worker, and after the things that add
 * cost. Returns how many alerts it raised.
 *
 * A threshold is recorded per budget period, so a retainer that goes over in
 * March is told again in April if it goes over again -- but not every hour of
 * March.
 */
export async function sweepProjectBudgets(ctx: ActorContext, projectIds?: string[]): Promise<number> {
  const today = await todayFor(ctx)
  const projects = (await budgetedProjects(ctx)).filter((p) => !projectIds || projectIds.includes(p.id))
  let raised = 0
  for (const project of projects) {
    const budget = await computeBudget(ctx, project, today)
    const status = budgetStatus({
      budgetMinor: budget.budgetMinor,
      costMinor: budget.costMinor,
      budgetHours: budget.budgetHours,
      loggedSeconds: Math.round(budget.loggedHours * 3600),
    })
    const periodStart = budget.window?.from ?? project.startDate ?? dateIn(project.createdAt, 'UTC')
    for (const crossed of status.crossed) {
      const inserted = await ctx.tx
        .insert(schema.projectBudgetAlerts)
        .values({
          id: newId(),
          organizationId: ctx.organizationId,
          projectId: project.id,
          measure: crossed.measure,
          periodStart,
          threshold: crossed.threshold,
          percent: Math.min(crossed.percent, 100_000),
          alertedAt: ctx.now,
        })
        .onConflictDoNothing()
        .returning({ id: schema.projectBudgetAlerts.id })
      if (inserted.length === 0) continue
      raised += 1
      const payload = { project: { id: project.id, name: project.name, ownerId: project.ownerId }, measure: crossed.measure, threshold: crossed.threshold, percent: crossed.percent, periodStart, budget }
      await ctx.audit({
        action: 'project.budget_threshold_crossed',
        entityType: 'project',
        entityId: project.id,
        entityLabel: project.name,
        changes: { [crossed.measure]: { from: null, to: `${crossed.percent}% (threshold ${crossed.threshold}%)` } },
      })
      await ctx.emit('project.budget_threshold_crossed', payload)
      await emailOwner(ctx, project, crossed, budget)
    }
  }
  return raised
}

async function emailOwner(
  ctx: ActorContext,
  project: ProjectRow,
  crossed: { measure: 'cost' | 'hours'; threshold: number; percent: number },
  budget: ProjectBudget,
): Promise<void> {
  if (!project.ownerId) return
  const [owner] = await ctx.tx.select({ email: schema.user.email, name: schema.user.name }).from(schema.user).where(eq(schema.user.id, project.ownerId)).limit(1)
  if (!owner?.email) return
  const { budgetAlertEmail, sendEmail } = await import('@workloom/emails')
  const { env } = await import('@workloom/config')
  const email = budgetAlertEmail({
    to: owner.email,
    project: project.name,
    measure: crossed.measure,
    percent: crossed.percent,
    threshold: crossed.threshold,
    used: crossed.measure === 'cost' ? { minor: budget.costMinor, currency: budget.currency } : { hours: budget.loggedHours },
    limit: crossed.measure === 'cost' ? { minor: budget.budgetMinor ?? 0, currency: budget.currency } : { hours: budget.budgetHours ?? 0 },
    period: budget.window ? `${budget.window.from} to ${budget.window.to}` : null,
    url: `${env.APP_URL.replace(/\/$/, '')}/projects/${project.id}?tab=financials`,
  })
  ctx.afterCommit(() => sendEmail(email))
}
