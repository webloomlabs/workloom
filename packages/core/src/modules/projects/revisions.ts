import { and, desc, eq, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId, optionalText, provided, requiredText } from '../crm/shared.ts'
import { signedMinorAmount } from '../finance/shared.ts'
import { today } from '../finance/documents.ts'
import { contractedValue } from './contract.ts'
import { assertDates, getProject, loadActiveProject, loadProject, requireFinancial } from './projects.ts'

/**
 * How a project changed after it was agreed.
 *
 * A variation changes scope and price; an extension changes only the dates.
 * Both follow the same short life -- drafted, sent, then answered -- because
 * both are the same conversation with the client.
 *
 * Accepting is the only step that touches the project, and it does two things
 * in one transaction: raises `contract_value_minor` by the revision's amount,
 * and moves the due date. Nothing else in the module writes to a project.
 *
 * Money is gated behind `report:readFinancial` the same way rates and budgets
 * are: a delivery person can see that the scope grew and the date moved without
 * seeing what the client is paying for it.
 */

type RevisionRow = typeof schema.projectRevisions.$inferSelect

export const projectRevisionOutput = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string(),
  number: z.number().int(),
  kind: z.enum(schema.PROJECT_REVISION_KINDS),
  title: z.string(),
  summary: z.string().nullable(),
  status: z.enum(schema.PROJECT_REVISION_STATUSES),
  currency: z.string().length(3),
  /** The change to the contracted value; negative for a descope. Null without `report:readFinancial`. */
  amountMinor: z.number().int().nullable(),
  newDueDate: z.iso.date().nullable(),
  requestedOn: z.iso.date(),
  quoteId: z.uuid().nullable(),
  quoteNumber: z.string().nullable(),
  /** What the project said before this was applied. Null until it is accepted. */
  previousContractValueMinor: z.number().int().nullable(),
  previousDueDate: z.iso.date().nullable(),
  appliedAt: z.date().nullable(),
  sentAt: z.date().nullable(),
  acceptedAt: z.date().nullable(),
  acceptedByName: z.string().nullable(),
  declinedAt: z.date().nullable(),
  declineReason: z.string().nullable(),
  withdrawnAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type ProjectRevision = z.infer<typeof projectRevisionOutput>

type RevisionJoin = { revision: RevisionRow; projectName: string; quoteNumber: string | null; acceptedByName: string | null }

function presentRevision(row: RevisionJoin, financial: boolean): ProjectRevision {
  const r = row.revision
  return {
    id: r.id,
    projectId: r.projectId,
    projectName: row.projectName,
    number: r.number,
    kind: r.kind as ProjectRevision['kind'],
    title: r.title,
    summary: r.summary,
    status: r.status as ProjectRevision['status'],
    currency: r.currency,
    amountMinor: financial ? r.amountMinor : null,
    newDueDate: r.newDueDate,
    requestedOn: r.requestedOn,
    quoteId: r.quoteId,
    quoteNumber: row.quoteNumber,
    previousContractValueMinor: financial ? r.previousContractValueMinor : null,
    previousDueDate: r.previousDueDate,
    appliedAt: r.appliedAt,
    sentAt: r.sentAt,
    acceptedAt: r.acceptedAt,
    acceptedByName: row.acceptedByName,
    declinedAt: r.declinedAt,
    declineReason: r.declineReason,
    withdrawnAt: r.withdrawnAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function selectRevisions(ctx: ActorContext) {
  const r = schema.projectRevisions
  return ctx.tx
    .select({
      revision: r,
      projectName: schema.projects.name,
      quoteNumber: schema.quotes.number,
      acceptedByName: schema.user.name,
    })
    .from(r)
    .innerJoin(schema.projects, eq(schema.projects.id, r.projectId))
    .leftJoin(schema.quotes, eq(schema.quotes.id, r.quoteId))
    .leftJoin(schema.user, eq(schema.user.id, r.acceptedBy))
}

export async function getRevision(
  ctx: ActorContext,
  id: string,
  financial = ctx.has('report:readFinancial'),
): Promise<ProjectRevision> {
  const [row] = await selectRevisions(ctx).where(eq(schema.projectRevisions.id, id)).limit(1)
  if (!row) throw new NotFoundError('Project revision', id)
  return presentRevision(row, financial)
}

async function loadRevision(ctx: ActorContext, id: string, options: { lock?: boolean } = {}): Promise<RevisionRow> {
  const query = ctx.tx.select().from(schema.projectRevisions).where(eq(schema.projectRevisions.id, id)).limit(1)
  const [row] = await (options.lock ? query.for('update') : query)
  if (!row) throw new NotFoundError('Project revision', id)
  return row
}

/** A revision that has left draft is a statement to the client. Nothing edits one. */
function requireDraft(revision: RevisionRow): void {
  if (revision.status !== 'draft') {
    throw new DomainError(
      `Revision ${revision.number} has already been ${revision.status}. Its content can no longer change.`,
      'revision_not_draft',
    )
  }
}

/**
 * The project's agreed price plus everything accepted against it.
 *
 * Read wherever a project is shown with money on it, so the contracted figure
 * and the revision list can never disagree.
 */
export async function contractFor(
  ctx: ActorContext,
  project: { id: string; contractValueMinor: number | null },
): Promise<{ contractValueMinor: number | null; contractedValueMinor: number | null; acceptedRevisionsMinor: number; revisionCount: number }> {
  const r = schema.projectRevisions
  const rows = await ctx.tx.select({ status: r.status, amountMinor: r.amountMinor }).from(r).where(eq(r.projectId, project.id))
  const accepted = rows.filter((row) => row.status === 'accepted').reduce((total, row) => total + row.amountMinor, 0)
  return {
    contractValueMinor: project.contractValueMinor,
    contractedValueMinor: contractedValue(project.contractValueMinor, rows),
    acceptedRevisionsMinor: accepted,
    revisionCount: rows.length,
  }
}

// Reads

export const projectRevisionList = defineProcedure({
  name: 'projectRevision.list',
  summary: 'The variations and extensions on a project, newest first',
  permission: 'projectRevision:read',
  readOnly: true,
  input: z.object({
    id: z.uuid(),
    status: z.enum(schema.PROJECT_REVISION_STATUSES).optional(),
    kind: z.enum(schema.PROJECT_REVISION_KINDS).optional(),
  }),
  output: z.object({ data: z.array(projectRevisionOutput) }),
  http: { method: 'GET', path: '/projects/{id}/revisions' },
  async handler(ctx, input) {
    const r = schema.projectRevisions
    await loadProject(ctx, input.id)
    const conditions: Array<SQL | undefined> = [
      eq(r.projectId, input.id),
      input.status ? eq(r.status, input.status) : undefined,
      input.kind ? eq(r.kind, input.kind) : undefined,
    ]
    const rows = await selectRevisions(ctx).where(and(...conditions)).orderBy(desc(r.number))
    const financial = ctx.has('report:readFinancial')
    return { data: rows.map((row) => presentRevision(row, financial)) }
  },
})

export const projectRevisionGet = defineProcedure({
  name: 'projectRevision.get',
  summary: 'One variation or extension',
  permission: 'projectRevision:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: projectRevisionOutput,
  http: { method: 'GET', path: '/project-revisions/{id}' },
  async handler(ctx, input) {
    return getRevision(ctx, input.id)
  },
})

// Writes

const revisionFields = {
  summary: optionalText(10_000),
  /** The project's new due date once accepted. Null leaves the dates alone. */
  newDueDate: z.iso.date().nullish(),
  /** The quote that put this to the client formally, where there was one. */
  quoteId: z.uuid().nullish(),
}

/** An extension moves time only; the check in the schema says so too. */
function assertKind(kind: string, amountMinor: number, newDueDate: string | null | undefined) {
  if (kind !== 'extension') return
  if (amountMinor !== 0) {
    throw new DomainError('An extension changes the dates, not the price. Record a variation instead.', 'extension_priced', 'amountMinor')
  }
  if (!newDueDate) {
    throw new DomainError('An extension needs a new due date, or it changes nothing.', 'extension_undated', 'newDueDate')
  }
}

export const projectRevisionCreate = defineProcedure({
  name: 'projectRevision.create',
  summary: 'Draft a scope or price variation, or an extension to the dates',
  permission: 'projectRevision:create',
  input: z.object({
    id: z.uuid(),
    title: requiredText(200, 'Title'),
    kind: z.enum(schema.PROJECT_REVISION_KINDS).default('variation'),
    /** The change to the contracted value. Negative takes work out. */
    amountMinor: signedMinorAmount.optional(),
    requestedOn: z.iso.date().optional(),
    ...revisionFields,
  }),
  output: projectRevisionOutput,
  http: { method: 'POST', path: '/projects/{id}/revisions', successStatus: 201 },
  emits: ['project_revision.created'],
  async handler(ctx, input) {
    // Locked for the whole transaction, so two people drafting at once cannot
    // take the same number -- the same serialisation task dependencies use.
    const project = await loadActiveProject(ctx, input.id, { lock: true })
    const amountMinor = input.amountMinor ?? 0
    requireFinancial(ctx, amountMinor !== 0)
    assertKind(input.kind, amountMinor, input.newDueDate)
    assertDates(project.startDate, input.newDueDate)
    if (input.quoteId) {
      const [quote] = await ctx.tx.select({ id: schema.quotes.id }).from(schema.quotes).where(eq(schema.quotes.id, input.quoteId)).limit(1)
      if (!quote) throw new NotFoundError('Quote', input.quoteId)
    }

    const [last] = await ctx.tx
      .select({ number: sql<number>`coalesce(max(${schema.projectRevisions.number}), 0)::int` })
      .from(schema.projectRevisions)
      .where(eq(schema.projectRevisions.projectId, project.id))

    const id = newId()
    await ctx.tx.insert(schema.projectRevisions).values({
      id,
      organizationId: ctx.organizationId,
      projectId: project.id,
      number: (last?.number ?? 0) + 1,
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? null,
      status: 'draft',
      // From the project, not the caller: the foreign key requires they agree.
      currency: project.currency,
      amountMinor,
      newDueDate: input.newDueDate ?? null,
      requestedOn: input.requestedOn ?? (await today(ctx)),
      quoteId: input.quoteId ?? null,
      createdBy: actingUserId(ctx),
    })

    const revision = await getRevision(ctx, id)
    await ctx.audit({
      action: 'project_revision.created',
      entityType: 'project',
      entityId: project.id,
      entityLabel: `Revision ${revision.number} — ${revision.title}`,
    })
    await ctx.emit('project_revision.created', revision)
    return revision
  },
})

export const projectRevisionUpdate = defineProcedure({
  name: 'projectRevision.update',
  summary: 'Change a draft revision',
  permission: 'projectRevision:update',
  input: z.object({
    id: z.uuid(),
    title: requiredText(200, 'Title').optional(),
    kind: z.enum(schema.PROJECT_REVISION_KINDS).optional(),
    amountMinor: signedMinorAmount.optional(),
    requestedOn: z.iso.date().optional(),
    ...revisionFields,
  }),
  output: projectRevisionOutput,
  http: { method: 'PATCH', path: '/project-revisions/{id}' },
  emits: ['project_revision.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadRevision(ctx, id, { lock: true })
    requireDraft(before)
    const patch = provided(fields)
    requireFinancial(ctx, 'amountMinor' in patch || before.amountMinor !== 0)

    const kind = patch.kind ?? before.kind
    const amountMinor = patch.amountMinor ?? before.amountMinor
    const newDueDate = 'newDueDate' in patch ? patch.newDueDate : before.newDueDate
    assertKind(kind, amountMinor, newDueDate)

    const project = await loadProject(ctx, before.projectId)
    assertDates(project.startDate, newDueDate)

    const changes = diff(before as unknown as Record<string, unknown>, patch as Partial<RevisionRow>)
    if (!changes) return getRevision(ctx, id)

    await ctx.tx
      .update(schema.projectRevisions)
      .set({ ...(patch as Partial<RevisionRow>), updatedAt: ctx.now })
      .where(eq(schema.projectRevisions.id, id))

    const revision = await getRevision(ctx, id)
    await ctx.audit({
      action: 'project_revision.updated',
      entityType: 'project',
      entityId: before.projectId,
      entityLabel: `Revision ${revision.number} — ${revision.title}`,
      changes,
    })
    await ctx.emit('project_revision.updated', revision)
    return revision
  },
})

export const projectRevisionSend = defineProcedure({
  name: 'projectRevision.send',
  summary: 'Put a revision to the client. It can no longer be edited.',
  permission: 'projectRevision:send',
  input: z.object({ id: z.uuid() }),
  output: projectRevisionOutput,
  http: { method: 'POST', path: '/project-revisions/{id}/send' },
  emits: ['project_revision.sent'],
  async handler(ctx, input) {
    const before = await loadRevision(ctx, input.id, { lock: true })
    requireDraft(before)

    await ctx.tx
      .update(schema.projectRevisions)
      .set({ status: 'sent', sentAt: ctx.now, updatedAt: ctx.now })
      .where(eq(schema.projectRevisions.id, input.id))

    const revision = await getRevision(ctx, input.id)
    await ctx.audit({
      action: 'project_revision.sent',
      entityType: 'project',
      entityId: before.projectId,
      entityLabel: `Revision ${revision.number} — ${revision.title}`,
    })
    await ctx.emit('project_revision.sent', revision)
    return revision
  },
})

export const projectRevisionAccept = defineProcedure({
  name: 'projectRevision.accept',
  summary: "Agree a revision: raises the project's contracted value and moves its due date",
  permission: 'projectRevision:accept',
  input: z.object({
    id: z.uuid(),
    /**
     * Also add the amount to the project's budget. Off by default: the budget
     * is what the work may cost us, and being paid more does not by itself mean
     * the work is allowed to cost more.
     */
    raiseBudget: z.boolean().default(false),
  }),
  output: projectRevisionOutput,
  http: { method: 'POST', path: '/project-revisions/{id}/accept' },
  emits: ['project_revision.accepted', 'project.updated'],
  async handler(ctx, input) {
    const before = await loadRevision(ctx, input.id, { lock: true })
    requireFinancial(ctx, before.amountMinor !== 0)
    if (before.status !== 'sent') {
      throw new DomainError(
        before.status === 'draft'
          ? 'Send the revision to the client before accepting it.'
          : `Revision ${before.number} was already ${before.status}.`,
        'revision_not_sent',
      )
    }

    // After the revision lock, and held for the rest of the transaction: two
    // concurrent accepts against one project queue up rather than both reading
    // the same contracted total.
    const project = await loadActiveProject(ctx, before.projectId, { lock: true })
    const dueDate = before.newDueDate ?? project.dueDate
    assertDates(project.startDate, dueDate)

    // `projects.contract_value_minor` is the price originally agreed and is
    // deliberately NOT touched here. The contracted total is that price plus
    // the accepted revisions, derived by `contractedValue` -- so the accepted
    // rows are the only record of every change, and nothing has to be kept in
    // step with anything else.
    const before_ = await contractFor(ctx, project)
    const after = (before_.contractedValueMinor ?? 0) + before.amountMinor
    if (before.amountMinor !== 0 && after < 0) {
      throw new DomainError(
        'That descope is larger than what the project is contracted for.',
        'descope_below_zero',
        'amountMinor',
      )
    }
    const budgetMinor =
      input.raiseBudget && before.amountMinor !== 0 ? Math.max(0, (project.budgetMinor ?? 0) + before.amountMinor) : project.budgetMinor

    if (dueDate !== project.dueDate || budgetMinor !== project.budgetMinor) {
      await ctx.tx
        .update(schema.projects)
        .set({ dueDate, budgetMinor, updatedAt: ctx.now })
        .where(eq(schema.projects.id, project.id))
    }

    await ctx.tx
      .update(schema.projectRevisions)
      .set({
        status: 'accepted',
        acceptedAt: ctx.now,
        acceptedBy: actingUserId(ctx),
        // Written together with `applied_at`, which the schema requires: what
        // the project was contracted for before this, so the timeline renders
        // without a join to the audit log.
        previousContractValueMinor: before_.contractedValueMinor,
        previousDueDate: project.dueDate,
        appliedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .where(eq(schema.projectRevisions.id, input.id))

    const revision = await getRevision(ctx, input.id)
    await ctx.audit({
      action: 'project_revision.accepted',
      entityType: 'project',
      entityId: project.id,
      entityLabel: `Revision ${revision.number} — ${revision.title}`,
      // The audit entry, not the columns above, is the authoritative record.
      changes: {
        ...(before.amountMinor !== 0 ? { contractedValueMinor: { from: before_.contractedValueMinor, to: after } } : {}),
        ...(dueDate !== project.dueDate ? { dueDate: { from: project.dueDate, to: dueDate } } : {}),
        ...(budgetMinor !== project.budgetMinor ? { budgetMinor: { from: project.budgetMinor, to: budgetMinor } } : {}),
      },
    })
    await ctx.emit('project_revision.accepted', revision)
    // The project as the event catalogue already describes it, after the change.
    await ctx.emit('project.updated', await getProject(ctx, project.id))
    return revision
  },
})

export const projectRevisionDecline = defineProcedure({
  name: 'projectRevision.decline',
  summary: 'Record that the client turned a revision down',
  permission: 'projectRevision:accept',
  input: z.object({ id: z.uuid(), reason: optionalText(2_000) }),
  output: projectRevisionOutput,
  http: { method: 'POST', path: '/project-revisions/{id}/decline' },
  emits: ['project_revision.declined'],
  async handler(ctx, input) {
    const before = await loadRevision(ctx, input.id, { lock: true })
    if (before.status !== 'sent') {
      throw new DomainError(
        before.status === 'draft' ? 'That revision has not been sent yet.' : `Revision ${before.number} was already ${before.status}.`,
        'revision_not_sent',
      )
    }

    await ctx.tx
      .update(schema.projectRevisions)
      .set({ status: 'declined', declinedAt: ctx.now, declineReason: input.reason ?? null, updatedAt: ctx.now })
      .where(eq(schema.projectRevisions.id, input.id))

    const revision = await getRevision(ctx, input.id)
    await ctx.audit({
      action: 'project_revision.declined',
      entityType: 'project',
      entityId: before.projectId,
      entityLabel: `Revision ${revision.number} — ${revision.title}`,
    })
    await ctx.emit('project_revision.declined', revision)
    return revision
  },
})

export const projectRevisionWithdraw = defineProcedure({
  name: 'projectRevision.withdraw',
  summary: 'Take back a revision the client has not answered',
  permission: 'projectRevision:update',
  input: z.object({ id: z.uuid() }),
  output: projectRevisionOutput,
  http: { method: 'POST', path: '/project-revisions/{id}/withdraw' },
  emits: ['project_revision.withdrawn'],
  async handler(ctx, input) {
    const before = await loadRevision(ctx, input.id, { lock: true })
    if (before.status !== 'sent') {
      throw new DomainError(
        before.status === 'draft' ? 'That revision has not been sent. Delete it instead.' : `Revision ${before.number} was already ${before.status}.`,
        'revision_not_sent',
      )
    }

    await ctx.tx
      .update(schema.projectRevisions)
      .set({ status: 'withdrawn', withdrawnAt: ctx.now, updatedAt: ctx.now })
      .where(eq(schema.projectRevisions.id, input.id))

    const revision = await getRevision(ctx, input.id)
    await ctx.audit({
      action: 'project_revision.withdrawn',
      entityType: 'project',
      entityId: before.projectId,
      entityLabel: `Revision ${revision.number} — ${revision.title}`,
    })
    await ctx.emit('project_revision.withdrawn', revision)
    return revision
  },
})

export const projectRevisionDelete = defineProcedure({
  name: 'projectRevision.delete',
  summary: 'Delete a draft revision. Once sent, withdraw it instead.',
  permission: 'projectRevision:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.uuid() }),
  http: { method: 'DELETE', path: '/project-revisions/{id}' },
  emits: ['project_revision.deleted'],
  async handler(ctx, input) {
    const revision = await loadRevision(ctx, input.id, { lock: true })
    if (revision.status !== 'draft') {
      throw new DomainError(
        `Revision ${revision.number} has been ${revision.status} and is part of the record. Withdraw it rather than deleting it.`,
        'revision_not_draft',
      )
    }

    await ctx.tx.delete(schema.projectRevisions).where(eq(schema.projectRevisions.id, input.id))
    await ctx.audit({
      action: 'project_revision.deleted',
      entityType: 'project',
      entityId: revision.projectId,
      entityLabel: `Revision ${revision.number} — ${revision.title}`,
    })
    await ctx.emit('project_revision.deleted', { id: input.id, projectId: revision.projectId, number: revision.number })
    return { id: input.id }
  },
})
