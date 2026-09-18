import { and, asc, eq, schema, sql } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId, optionalText, requiredText } from '../crm/shared.ts'
import { newLineValues } from '../finance/documents.ts'
import { defaultTerms, getInvoice, recalculate } from '../finance/invoices.ts'
import { fromNumeric, percentInput } from '../finance/shared.ts'
import { planTotals, type StageForTotals } from './billing-plan.ts'
import { releaseStageForInvoice } from './stage-release.ts'
import { loadActiveProject, loadProject } from './projects.ts'
import { contractFor } from './revisions.ts'

/**
 * A project's billing plan: the advance, the mid-term, the final.
 *
 * Releasing a stage raises a *draft* invoice, never an issued one. Someone
 * still reads it before the client does, which is the same rule recurring
 * billing follows and for the same reason: nothing bills a client without a
 * person having looked.
 *
 * Over-billing is refused here rather than by a trigger. The ceiling lives in
 * two other tables -- the project's agreed price plus its accepted revisions --
 * and a row-level check cannot see either. The project row lock taken on
 * release is what serialises two people releasing at once, which is the only
 * race that matters.
 */

type StageRow = typeof schema.projectBillingStages.$inferSelect

export const billingStageOutput = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  position: z.number().int(),
  name: z.string(),
  basis: z.enum(schema.BILLING_STAGE_BASIS),
  percent: z.string().nullable(),
  amountMinor: z.number().int().nullable(),
  currency: z.string().length(3),
  /** What it is worth right now: the fixed amount, or its share of the contracted value. */
  resolvedAmountMinor: z.number().int(),
  trigger: z.string().nullable(),
  dueOn: z.iso.date().nullable(),
  milestoneId: z.uuid().nullable(),
  milestoneName: z.string().nullable(),
  revisionId: z.uuid().nullable(),
  status: z.enum(schema.BILLING_STAGE_STATUSES),
  /** What it was worth when it was billed. Never recomputed. */
  releasedAmountMinor: z.number().int().nullable(),
  invoiceId: z.uuid().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceStatus: z.string().nullable(),
  releasedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type BillingStage = z.infer<typeof billingStageOutput>

const summaryOutput = z.object({
  projectId: z.uuid(),
  currency: z.string().length(3),
  contractValueMinor: z.number().int().nullable(),
  contractedValueMinor: z.number().int().nullable(),
  acceptedRevisionsMinor: z.number().int(),
  /** What the stages come to at today's contracted value. */
  plannedMinor: z.number().int(),
  /** What has been billed through the plan. Cancelled invoices do not count. */
  releasedMinor: z.number().int(),
  /** Contracted less released. Null without an agreed total. */
  remainingMinor: z.number().int().nullable(),
  /** How far the plan over-commits the contract. Zero when it does not. */
  overCommittedMinor: z.number().int(),
  /**
   * Invoiced against this project outside the plan -- a retainer, or a hand-written
   * invoice. Shown so the two figures visibly reconcile rather than leaving
   * someone to wonder where the difference went.
   */
  otherInvoicedMinor: z.number().int(),
  stages: z.array(billingStageOutput),
})

type StageJoin = { stage: StageRow; milestoneName: string | null; invoiceNumber: string | null; invoiceStatus: string | null }

function selectStages(ctx: ActorContext) {
  const s = schema.projectBillingStages
  return ctx.tx
    .select({
      stage: s,
      milestoneName: schema.milestones.name,
      invoiceNumber: schema.invoices.number,
      invoiceStatus: schema.invoices.status,
    })
    .from(s)
    .leftJoin(schema.milestones, eq(schema.milestones.id, s.milestoneId))
    .leftJoin(schema.invoices, eq(schema.invoices.id, s.invoiceId))
}

const forTotals = (row: StageJoin): StageForTotals => ({
  id: row.stage.id,
  position: row.stage.position,
  basis: row.stage.basis,
  percent: row.stage.percent,
  amountMinor: row.stage.amountMinor,
  status: row.stage.status,
  releasedAmountMinor: row.stage.releasedAmountMinor,
  invoiceStatus: row.invoiceStatus,
})

function presentStage(row: StageJoin, resolvedAmountMinor: number): BillingStage {
  const s = row.stage
  return {
    id: s.id,
    projectId: s.projectId,
    position: s.position,
    name: s.name,
    basis: s.basis as BillingStage['basis'],
    percent: fromNumeric(s.percent),
    amountMinor: s.amountMinor,
    currency: s.currency,
    resolvedAmountMinor,
    trigger: s.trigger,
    dueOn: s.dueOn,
    milestoneId: s.milestoneId,
    milestoneName: row.milestoneName,
    revisionId: s.revisionId,
    status: s.status as BillingStage['status'],
    releasedAmountMinor: s.releasedAmountMinor,
    invoiceId: s.invoiceId,
    invoiceNumber: row.invoiceNumber,
    invoiceStatus: row.invoiceStatus,
    releasedAt: s.releasedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

/**
 * The plan and its arithmetic, in one read. Everything that needs to know what
 * a stage is worth goes through here, so no two callers can resolve a
 * percentage differently.
 */
export async function planFor(
  ctx: ActorContext,
  project: { id: string; currency: string; contractValueMinor: number | null },
): Promise<z.infer<typeof summaryOutput>> {
  const s = schema.projectBillingStages
  const [rows, contract] = await Promise.all([
    selectStages(ctx).where(eq(s.projectId, project.id)).orderBy(asc(s.position)),
    contractFor(ctx, project),
  ])
  const totals = planTotals({ contractedValueMinor: contract.contractedValueMinor, stages: rows.map(forTotals) })

  // What the project was billed outside the plan: everything attributed to it,
  // less what the stages account for. A retainer must not eat a build's contract.
  const [billed] = await ctx.tx
    .select({
      total: sql<number>`coalesce(sum(${schema.invoices.totalMinor} - ${schema.invoices.taxMinor}), 0)::int`,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.projectId, project.id),
        eq(schema.invoices.currency, project.currency),
        sql`${schema.invoices.status} not in ('draft', 'cancelled')`,
      ),
    )
  const releasedAndIssued = rows
    .filter((r) => r.stage.status === 'invoiced' && r.invoiceStatus !== null && !['draft', 'cancelled'].includes(r.invoiceStatus))
    .reduce((total, r) => total + (r.stage.releasedAmountMinor ?? 0), 0)

  return {
    projectId: project.id,
    currency: project.currency,
    ...contract,
    plannedMinor: totals.plannedMinor,
    releasedMinor: totals.releasedMinor,
    remainingMinor: totals.remainingMinor,
    overCommittedMinor: totals.overCommittedMinor,
    otherInvoicedMinor: Math.max(0, (billed?.total ?? 0) - releasedAndIssued),
    stages: rows.map((row) => presentStage(row, totals.stageAmounts.get(row.stage.id) ?? 0)),
  }
}

async function loadStage(ctx: ActorContext, id: string, options: { lock?: boolean } = {}): Promise<StageRow> {
  const query = ctx.tx.select().from(schema.projectBillingStages).where(eq(schema.projectBillingStages.id, id)).limit(1)
  const [row] = await (options.lock ? query.for('update') : query)
  if (!row) throw new NotFoundError('Billing stage', id)
  return row
}

async function getStage(ctx: ActorContext, id: string): Promise<BillingStage> {
  const stage = await loadStage(ctx, id)
  const project = await loadProject(ctx, stage.projectId)
  const plan = await planFor(ctx, project)
  const found = plan.stages.find((s) => s.id === id)
  if (!found) throw new NotFoundError('Billing stage', id)
  return found
}

// Reads

export const projectBillingStageList = defineProcedure({
  name: 'projectBillingStage.list',
  summary: "A project's billing plan, with what each stage is worth today",
  permission: 'projectBilling:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: summaryOutput,
  http: { method: 'GET', path: '/projects/{id}/billing-stages' },
  async handler(ctx, input) {
    return planFor(ctx, await loadProject(ctx, input.id))
  },
})

export const projectBillingSummary = defineProcedure({
  name: 'project.billingSummary',
  summary: 'What a project is contracted for, what has been billed against it, and what is left',
  permission: 'projectBilling:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: summaryOutput.omit({ stages: true }),
  http: { method: 'GET', path: '/projects/{id}/billing-summary' },
  async handler(ctx, input) {
    const { stages: _stages, ...summary } = await planFor(ctx, await loadProject(ctx, input.id))
    return summary
  },
})

// Writes

const stageFields = {
  /** What has to be true before it is billed, in words. */
  trigger: optionalText(500),
  dueOn: z.iso.date().nullish(),
  /** The milestone whose completion releases it. */
  milestoneId: z.uuid().nullish(),
}

/** A stage is worth a fixed amount or a share, and the caller says which. */
function assertBasis(basis: string, amountMinor: number | null | undefined, percent: string | null | undefined) {
  if (basis === 'percent') {
    if (percent == null) throw new DomainError('Enter the share of the contract this stage bills.', 'percent_required', 'percent')
  } else if (amountMinor == null) {
    throw new DomainError('Enter what this stage bills.', 'amount_required', 'amountMinor')
  }
}

export const projectBillingStageCreate = defineProcedure({
  name: 'projectBillingStage.create',
  summary: 'Add a stage to a project’s billing plan',
  permission: 'projectBilling:update',
  input: z.object({
    id: z.uuid(),
    name: requiredText(200, 'Name'),
    basis: z.enum(schema.BILLING_STAGE_BASIS).default('amount'),
    /** A share of what the project is contracted for, following it as revisions raise it. */
    percent: percentInput.nullish(),
    amountMinor: z.number().int().min(0).nullish(),
    ...stageFields,
  }),
  output: billingStageOutput,
  http: { method: 'POST', path: '/projects/{id}/billing-stages', successStatus: 201 },
  emits: ['project_billing_stage.created'],
  async handler(ctx, input) {
    const project = await loadActiveProject(ctx, input.id, { lock: true })
    assertBasis(input.basis, input.amountMinor, input.percent)
    if (input.milestoneId) {
      const [milestone] = await ctx.tx
        .select({ id: schema.milestones.id })
        .from(schema.milestones)
        .where(and(eq(schema.milestones.id, input.milestoneId), eq(schema.milestones.projectId, project.id)))
        .limit(1)
      if (!milestone) throw new NotFoundError('Milestone', input.milestoneId)
    }

    const s = schema.projectBillingStages
    const [last] = await ctx.tx
      .select({ position: sql<number>`coalesce(max(${s.position}), 0)::int` })
      .from(s)
      .where(eq(s.projectId, project.id))

    const id = newId()
    await ctx.tx.insert(s).values({
      id,
      organizationId: ctx.organizationId,
      projectId: project.id,
      position: (last?.position ?? 0) + 1,
      name: input.name,
      basis: input.basis,
      percent: input.basis === 'percent' ? (input.percent ?? null) : null,
      amountMinor: input.basis === 'amount' ? (input.amountMinor ?? null) : null,
      // From the project, not the caller: the foreign key requires they agree.
      currency: project.currency,
      trigger: input.trigger ?? null,
      dueOn: input.dueOn ?? null,
      milestoneId: input.milestoneId ?? null,
      createdBy: actingUserId(ctx),
    })

    const stage = await getStage(ctx, id)
    await ctx.audit({ action: 'project_billing_stage.created', entityType: 'project', entityId: project.id, entityLabel: stage.name })
    await ctx.emit('project_billing_stage.created', stage)
    return stage
  },
})

export const projectBillingStageUpdate = defineProcedure({
  name: 'projectBillingStage.update',
  summary: 'Change a stage that has not been billed yet',
  permission: 'projectBilling:update',
  input: z.object({
    id: z.uuid(),
    name: requiredText(200, 'Name').optional(),
    basis: z.enum(schema.BILLING_STAGE_BASIS).optional(),
    percent: percentInput.nullish(),
    amountMinor: z.number().int().min(0).nullish(),
    ...stageFields,
  }),
  output: billingStageOutput,
  http: { method: 'PATCH', path: '/billing-stages/{id}' },
  emits: ['project_billing_stage.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadStage(ctx, id, { lock: true })
    if (before.status === 'invoiced') {
      throw new DomainError(
        `“${before.name}” has already raised its invoice. Delete that draft to change the stage.`,
        'stage_invoiced',
      )
    }

    const basis = fields.basis ?? before.basis
    const percent = fields.percent !== undefined ? fields.percent : before.percent
    const amountMinor = fields.amountMinor !== undefined ? fields.amountMinor : before.amountMinor
    assertBasis(basis, amountMinor, percent)

    // The two are exclusive in the database, so whichever is not in use is cleared.
    const patch: Partial<StageRow> = {
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...(fields.trigger !== undefined ? { trigger: fields.trigger ?? null } : {}),
      ...(fields.dueOn !== undefined ? { dueOn: fields.dueOn ?? null } : {}),
      ...(fields.milestoneId !== undefined ? { milestoneId: fields.milestoneId ?? null } : {}),
      basis,
      percent: basis === 'percent' ? (percent ?? null) : null,
      amountMinor: basis === 'amount' ? (amountMinor ?? null) : null,
    }

    const changes = diff(before as unknown as Record<string, unknown>, patch)
    if (!changes) return getStage(ctx, id)

    await ctx.tx.update(schema.projectBillingStages).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.projectBillingStages.id, id))
    const stage = await getStage(ctx, id)
    await ctx.audit({
      action: 'project_billing_stage.updated',
      entityType: 'project',
      entityId: before.projectId,
      entityLabel: stage.name,
      changes,
    })
    await ctx.emit('project_billing_stage.updated', stage)
    return stage
  },
})

export const projectBillingStageReorder = defineProcedure({
  name: 'projectBillingStage.reorder',
  summary: 'Put the stages of a plan in a different order',
  permission: 'projectBilling:update',
  input: z.object({ id: z.uuid(), stageIds: z.array(z.uuid()).min(1).max(100) }),
  output: summaryOutput,
  http: { method: 'POST', path: '/projects/{id}/billing-stages/reorder' },
  emits: ['project_billing_stage.updated'],
  async handler(ctx, input) {
    const project = await loadActiveProject(ctx, input.id, { lock: true })
    const s = schema.projectBillingStages
    const existing = await ctx.tx.select({ id: s.id }).from(s).where(eq(s.projectId, project.id))
    const known = new Set(existing.map((row) => row.id))
    if (input.stageIds.length !== known.size || input.stageIds.some((id) => !known.has(id))) {
      throw new DomainError('Send every stage of the plan, once each, in the order you want.', 'stages_incomplete', 'stageIds')
    }

    // Moved out of the way first: the positions are unique per project, so
    // assigning them one at a time would collide part-way through.
    await ctx.tx.update(s).set({ position: sql`${s.position} + 1000` }).where(eq(s.projectId, project.id))
    for (const [index, id] of input.stageIds.entries()) {
      await ctx.tx.update(s).set({ position: index + 1, updatedAt: ctx.now }).where(eq(s.id, id))
    }

    const plan = await planFor(ctx, project)
    await ctx.audit({ action: 'project_billing_stage.updated', entityType: 'project', entityId: project.id, entityLabel: 'Billing plan' })
    await ctx.emit('project_billing_stage.updated', plan.stages)
    return plan
  },
})

export const projectBillingStageRemove = defineProcedure({
  name: 'projectBillingStage.remove',
  summary: 'Take a stage off the plan. One that has been billed stays.',
  permission: 'projectBilling:update',
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.uuid() }),
  http: { method: 'DELETE', path: '/billing-stages/{id}' },
  emits: ['project_billing_stage.removed'],
  async handler(ctx, input) {
    const stage = await loadStage(ctx, input.id, { lock: true })
    if (stage.status === 'invoiced') {
      throw new DomainError(
        `“${stage.name}” has raised an invoice and is part of what this project has been billed. Delete that draft first.`,
        'stage_invoiced',
      )
    }

    await ctx.tx.delete(schema.projectBillingStages).where(eq(schema.projectBillingStages.id, input.id))
    await ctx.audit({ action: 'project_billing_stage.removed', entityType: 'project', entityId: stage.projectId, entityLabel: stage.name })
    await ctx.emit('project_billing_stage.removed', { id: input.id, projectId: stage.projectId, name: stage.name })
    return { id: input.id }
  },
})

export const projectBillingStageRelease = defineProcedure({
  name: 'projectBillingStage.release',
  summary: 'Raise the draft invoice for a stage',
  permission: 'projectBilling:release',
  input: z.object({
    id: z.uuid(),
    contactId: z.uuid().nullish(),
    taxRateId: z.uuid().nullish(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
  }),
  output: z.object({ stage: billingStageOutput, invoiceId: z.uuid() }),
  http: { method: 'POST', path: '/billing-stages/{id}/release' },
  emits: ['invoice.created', 'project_billing_stage.released'],
  async handler(ctx, input) {
    // Raising an invoice is creating one, whoever asked -- the same escalation
    // `billingSchedule.generate` makes.
    ctx.require('invoice:create')
    const stage = await loadStage(ctx, input.id, { lock: true })
    if (stage.status !== 'pending') {
      throw new DomainError(
        stage.status === 'invoiced' ? `“${stage.name}” has already been billed.` : `“${stage.name}” was removed from the plan.`,
        'stage_not_pending',
      )
    }

    // Held for the rest of the transaction, so two releases against one project
    // queue up instead of both reading the same remaining figure.
    const project = await loadActiveProject(ctx, stage.projectId, { lock: true })
    if (!project.companyId) {
      throw new DomainError('An internal project has no client to bill.', 'project_internal')
    }

    const plan = await planFor(ctx, project)
    if (plan.contractedValueMinor === null) {
      throw new DomainError(
        "Set the project's contract value before releasing a stage: there is nothing to bill a share of.",
        'no_contract_value',
        'contractValueMinor',
      )
    }
    const amount = plan.stages.find((s) => s.id === stage.id)?.resolvedAmountMinor ?? 0
    if (amount <= 0) {
      throw new DomainError('That stage is worth nothing to bill.', 'stage_worth_nothing', 'amountMinor')
    }
    if (plan.releasedMinor + amount > plan.contractedValueMinor) {
      const left = plan.contractedValueMinor - plan.releasedMinor
      throw new DomainError(
        `That would bill more than this project is contracted for. ${left <= 0 ? 'Nothing' : left} remains of ${plan.contractedValueMinor}.`,
        'over_billing',
      )
    }

    const invoiceId = newId()
    await ctx.tx.insert(schema.invoices).values({
      id: invoiceId,
      organizationId: ctx.organizationId,
      companyId: project.companyId,
      contactId: input.contactId ?? null,
      projectId: project.id,
      title: `${project.name} — ${stage.name}`,
      currency: project.currency,
      paymentTermsDays: input.paymentTermsDays ?? (await defaultTerms(ctx)),
      createdBy: actingUserId(ctx),
    })
    await ctx.tx.insert(schema.invoiceLines).values({
      id: newId(),
      organizationId: ctx.organizationId,
      invoiceId,
      position: 1,
      // The same two calls a recurring schedule makes, so a staged invoice and
      // a recurring one are priced by identical code.
      ...(await newLineValues(
        ctx,
        { currency: project.currency },
        { description: stage.name, quantity: '1', unitAmountMinor: amount, taxRateId: input.taxRateId ?? null },
      )),
    })
    await recalculate(ctx, invoiceId)

    await ctx.tx
      .update(schema.projectBillingStages)
      .set({ status: 'invoiced', invoiceId, releasedAmountMinor: amount, releasedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(schema.projectBillingStages.id, stage.id))

    const invoice = await getInvoice(ctx, invoiceId)
    const released = await getStage(ctx, stage.id)
    await ctx.audit({
      action: 'project_billing_stage.released',
      entityType: 'project',
      entityId: project.id,
      entityLabel: stage.name,
      changes: { releasedAmountMinor: { from: null, to: amount } },
    })
    await ctx.emit('invoice.created', invoice)
    await ctx.emit('project_billing_stage.released', { stage: released, invoice })
    return { stage: released, invoiceId }
  },
})

// Re-exported so the plan's whole surface is reachable from one module.
export { releaseStageForInvoice }
