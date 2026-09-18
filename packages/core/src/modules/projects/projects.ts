import { and, desc, eq, ilike, inArray, isNull, lt, schema, sql } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from '../crm/companies.ts'
import { loadDeal } from '../crm/deals.ts'
import {
  actingUserId,
  assertMember,
  baseCurrency,
  contains,
  currencyCode,
  minorAmount,
  optionalText,
  pageInput,
  pageOutput,
  paginate,
  provided,
  queryFlag,
  refuseArchived,
  requiredText,
  searchInput,
} from '../crm/shared.ts'

type ProjectStatus = (typeof schema.PROJECT_STATUSES)[number]
type ProjectRow = typeof schema.projects.$inferSelect

const progressOutput = z.object({
  /** Tasks that count towards progress: everything except cancelled. */
  tasksTotal: z.number().int(),
  tasksDone: z.number().int(),
  milestonesTotal: z.number().int(),
  milestonesDone: z.number().int(),
  /**
   * Done tasks as a share of counted tasks. With no tasks, completed
   * milestones as a share of milestones. Null when there is neither -- a new
   * project is not "0% done", it is unplanned.
   */
  percent: z.number().int().min(0).max(100).nullable(),
})

export type Progress = z.infer<typeof progressOutput>

export const projectOutput = z.object({
  id: z.uuid(),
  companyId: z.uuid().nullable(),
  companyName: z.string().nullable(),
  dealId: z.uuid().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(schema.PROJECT_STATUSES),
  startDate: z.iso.date().nullable(),
  dueDate: z.iso.date().nullable(),
  currency: z.string().length(3),
  /**
   * Integer minor units of `currency`. Null when there is no budget, or when
   * the caller lacks `report:readFinancial` -- a budget is a commercial term.
   */
  budgetMinor: z.number().int().nullable(),
  ownerId: z.uuid().nullable(),
  progress: progressOutput,
  completedAt: z.date().nullable(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type Project = z.infer<typeof projectOutput>

const EMPTY_PROGRESS: Progress = { tasksTotal: 0, tasksDone: 0, milestonesTotal: 0, milestonesDone: 0, percent: null }

/** Progress for several projects in two grouped queries. */
export async function progressFor(ctx: ActorContext, projectIds: string[]): Promise<Map<string, Progress>> {
  const result = new Map<string, Progress>()
  if (projectIds.length === 0) return result

  const [taskCounts, milestoneCounts] = await Promise.all([
    ctx.tx
      .select({
        projectId: schema.tasks.projectId,
        total: sql<number>`count(*) filter (where ${schema.tasks.status} <> 'cancelled')::int`,
        done: sql<number>`count(*) filter (where ${schema.tasks.status} = 'done')::int`,
      })
      .from(schema.tasks)
      .where(inArray(schema.tasks.projectId, projectIds))
      .groupBy(schema.tasks.projectId),
    ctx.tx
      .select({
        projectId: schema.milestones.projectId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${schema.milestones.completedAt} is not null)::int`,
      })
      .from(schema.milestones)
      .where(inArray(schema.milestones.projectId, projectIds))
      .groupBy(schema.milestones.projectId),
  ])

  for (const id of projectIds) {
    const tasks = taskCounts.find((r) => r.projectId === id)
    const milestones = milestoneCounts.find((r) => r.projectId === id)
    const progress: Progress = {
      tasksTotal: tasks?.total ?? 0,
      tasksDone: tasks?.done ?? 0,
      milestonesTotal: milestones?.total ?? 0,
      milestonesDone: milestones?.done ?? 0,
      percent: null,
    }
    progress.percent = progressPercent(progress)
    result.set(id, progress)
  }
  return result
}

/** Rounded down, so a project shows 100% only when everything is done. */
export function progressPercent(p: Omit<Progress, 'percent'>): number | null {
  if (p.tasksTotal > 0) return Math.floor((p.tasksDone * 100) / p.tasksTotal)
  if (p.milestonesTotal > 0) return Math.floor((p.milestonesDone * 100) / p.milestonesTotal)
  return null
}

function selectProjects(ctx: ActorContext) {
  return ctx.tx
    .select({ project: schema.projects, companyName: schema.companies.name })
    .from(schema.projects)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.projects.companyId))
}

function present(
  row: { project: ProjectRow; companyName: string | null },
  progress: Progress,
  options: { financial: boolean },
): Project {
  const { project } = row
  return {
    id: project.id,
    companyId: project.companyId,
    companyName: row.companyName,
    dealId: project.dealId,
    name: project.name,
    description: project.description,
    status: project.status as ProjectStatus,
    startDate: project.startDate,
    dueDate: project.dueDate,
    currency: project.currency,
    budgetMinor: options.financial ? project.budgetMinor : null,
    ownerId: project.ownerId,
    progress,
    completedAt: project.completedAt,
    archivedAt: project.archivedAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

/** The caller's view of a project. */
export async function getProject(ctx: ActorContext, id: string): Promise<Project> {
  const [row] = await selectProjects(ctx).where(eq(schema.projects.id, id)).limit(1)
  if (!row) throw new NotFoundError('Project', id)
  const progress = (await progressFor(ctx, [id])).get(id) ?? EMPTY_PROGRESS
  return present(row, progress, { financial: ctx.has('report:readFinancial') })
}

/**
 * The representation sent to webhooks: complete, whoever caused the change.
 * Webhook endpoints are configured by administrators, who can see budgets.
 */
async function eventPayload(ctx: ActorContext, id: string): Promise<Project> {
  const [row] = await selectProjects(ctx).where(eq(schema.projects.id, id)).limit(1)
  const progress = (await progressFor(ctx, [id])).get(id) ?? EMPTY_PROGRESS
  return present(row!, progress, { financial: true })
}

export async function loadProject(ctx: ActorContext, id: string, options: { lock?: boolean } = {}) {
  const query = ctx.tx.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1)
  const [row] = options.lock ? await query.for('update') : await query
  if (!row) throw new NotFoundError('Project', id)
  return row
}

/** Loads a project that can still take new work. */
export async function loadActiveProject(ctx: ActorContext, id: string, options: { lock?: boolean } = {}) {
  const project = await loadProject(ctx, id, options)
  refuseArchived(project, 'project')
  return project
}

function assertDates(startDate: string | null | undefined, dueDate: string | null | undefined) {
  if (startDate && dueDate && dueDate < startDate) {
    throw new DomainError('The due date cannot be before the start date.', 'due_before_start', 'dueDate')
  }
}

function requireFinancial(ctx: ActorContext, touched: boolean) {
  // Budgets and rates are commercial terms: setting one is reading it.
  if (touched) ctx.require('report:readFinancial')
}

export const projectList = defineProcedure({
  name: 'project.list',
  summary: 'Projects, newest first, with their progress',
  permission: 'project:read',
  readOnly: true,
  input: z.object({
    q: searchInput,
    status: z.enum(schema.PROJECT_STATUSES).optional(),
    /** Only projects still in play: not completed, cancelled, or archived. */
    active: queryFlag,
    companyId: z.uuid().optional(),
    includeArchived: queryFlag,
    ...pageInput,
  }),
  output: pageOutput(projectOutput),
  http: { method: 'GET', path: '/projects' },
  async handler(ctx, input) {
    const p = schema.projects
    const rows = await selectProjects(ctx)
      .where(
        and(
          input.includeArchived ? undefined : isNull(p.archivedAt),
          input.status ? eq(p.status, input.status) : undefined,
          input.active ? sql`${p.status} not in ('completed', 'cancelled')` : undefined,
          input.companyId ? eq(p.companyId, input.companyId) : undefined,
          input.q ? ilike(p.name, contains(input.q)) : undefined,
          input.cursor ? lt(p.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(p.id))
      .limit(input.limit + 1)

    const page = paginate(rows.map((r) => ({ ...r, id: r.project.id })), input.limit)
    const progress = await progressFor(ctx, page.data.map((r) => r.id))
    const financial = ctx.has('report:readFinancial')
    return {
      nextCursor: page.nextCursor,
      data: page.data.map((r) => present(r, progress.get(r.id) ?? EMPTY_PROGRESS, { financial })),
    }
  },
})

export const projectGet = defineProcedure({
  name: 'project.get',
  summary: 'One project, with its progress',
  permission: 'project:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: projectOutput,
  http: { method: 'GET', path: '/projects/{id}' },
  async handler(ctx, input) {
    return getProject(ctx, input.id)
  },
})

const details = {
  description: optionalText(20_000),
  startDate: z.iso.date().nullish(),
  dueDate: z.iso.date().nullish(),
  budgetMinor: minorAmount.nullish(),
  ownerId: z.uuid().nullish(),
}

export const projectCreate = defineProcedure({
  name: 'project.create',
  summary: 'Start a project, for a client or internal',
  permission: 'project:create',
  input: z.object({
    name: requiredText(200, 'Name'),
    ...details,
    /** The client. Omit for an internal project. */
    companyId: z.uuid().nullish(),
    /** The won deal this delivers. Implies its company. */
    dealId: z.uuid().nullish(),
    status: z.enum(schema.PROJECT_STATUSES).exclude(['completed']).default('planning'),
    /** Defaults to the organization's base currency. */
    currency: currencyCode.optional(),
  }),
  output: projectOutput,
  http: { method: 'POST', path: '/projects', successStatus: 201 },
  emits: ['project.created', 'project_member.added'],
  async handler(ctx, input) {
    let companyId = input.companyId ?? null
    if (input.dealId) {
      const deal = await loadDeal(ctx, input.dealId)
      if (companyId && companyId !== deal.companyId) {
        throw new DomainError('That deal belongs to a different company.', 'deal_company_mismatch', 'dealId')
      }
      companyId = deal.companyId
    }
    if (companyId) refuseArchived(await loadCompany(ctx, companyId), 'company')
    assertDates(input.startDate, input.dueDate)
    requireFinancial(ctx, input.budgetMinor != null)

    const ownerId = input.ownerId === undefined ? actingUserId(ctx) : input.ownerId
    await assertMember(ctx, ownerId)

    const id = newId()
    await ctx.tx.insert(schema.projects).values({
      id,
      organizationId: ctx.organizationId,
      companyId,
      dealId: input.dealId ?? null,
      name: input.name,
      description: input.description ?? null,
      status: input.status,
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      currency: input.currency ?? (await baseCurrency(ctx)),
      budgetMinor: input.budgetMinor ?? null,
      ownerId,
      createdBy: actingUserId(ctx),
    })
    await ctx.audit({ action: 'project.created', entityType: 'project', entityId: id, entityLabel: input.name })
    await ctx.emit('project.created', await eventPayload(ctx, id))

    // The owner runs the project, so they are on it.
    if (ownerId) await insertMember(ctx, { projectId: id, userId: ownerId, role: 'manager' })

    return getProject(ctx, id)
  },
})

export const projectUpdate = defineProcedure({
  name: 'project.update',
  summary: "Change a project's details. Use the status endpoint to move it along.",
  permission: 'project:update',
  input: z.object({
    id: z.uuid(),
    name: requiredText(200, 'Name').optional(),
    ...details,
    companyId: z.uuid().nullish(),
    currency: currencyCode.optional(),
  }),
  output: projectOutput,
  http: { method: 'PATCH', path: '/projects/{id}' },
  emits: ['project.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadProject(ctx, id, { lock: true })
    const patch = provided(fields)
    requireFinancial(ctx, 'budgetMinor' in patch)
    if (patch.companyId && patch.companyId !== before.companyId) {
      refuseArchived(await loadCompany(ctx, patch.companyId), 'company')
    }
    if (patch.ownerId) await assertMember(ctx, patch.ownerId)
    if (patch.currency && patch.currency !== before.currency) {
      // Logged time holds rates in the project's currency. Relabelling the
      // project would leave those amounts, and its member rates, meaning
      // something they never did.
      const [logged] = await ctx.tx
        .select({ id: schema.timeEntries.id })
        .from(schema.timeEntries)
        .where(eq(schema.timeEntries.projectId, id))
        .limit(1)
      if (logged) {
        throw new DomainError("Time has been logged on this project, so its currency can't change.", 'currency_locked', 'currency')
      }
    }
    assertDates(
      patch.startDate !== undefined ? patch.startDate : before.startDate,
      patch.dueDate !== undefined ? patch.dueDate : before.dueDate,
    )

    const changes = diff(before as Record<string, unknown>, patch)
    if (!changes) return getProject(ctx, id)

    await ctx.tx.update(schema.projects).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.projects.id, id))
    await ctx.audit({ action: 'project.updated', entityType: 'project', entityId: id, entityLabel: patch.name ?? before.name, changes })
    await ctx.emit('project.updated', await eventPayload(ctx, id))
    return getProject(ctx, id)
  },
})

export const projectChangeStatus = defineProcedure({
  name: 'project.changeStatus',
  summary: 'Move a project to another status, including completed or cancelled',
  permission: 'project:update',
  input: z.object({ id: z.uuid(), status: z.enum(schema.PROJECT_STATUSES) }),
  output: projectOutput.extend({ previousStatus: z.enum(schema.PROJECT_STATUSES) }),
  http: { method: 'POST', path: '/projects/{id}/status' },
  emits: ['project.status_changed', 'project.completed'],
  async handler(ctx, input) {
    const before = await loadActiveProject(ctx, input.id, { lock: true })
    const previousStatus = before.status as ProjectStatus
    if (previousStatus === input.status) return { ...(await getProject(ctx, before.id)), previousStatus }

    await ctx.tx
      .update(schema.projects)
      .set({ status: input.status, completedAt: input.status === 'completed' ? ctx.now : null, updatedAt: ctx.now })
      .where(eq(schema.projects.id, before.id))
    await ctx.audit({
      action: input.status === 'completed' ? 'project.completed' : 'project.status_changed',
      entityType: 'project',
      entityId: before.id,
      entityLabel: before.name,
      changes: { status: { from: previousStatus, to: input.status } },
    })

    const payload = { ...(await eventPayload(ctx, before.id)), previousStatus }
    await ctx.emit('project.status_changed', payload)
    if (input.status === 'completed') await ctx.emit('project.completed', payload)
    return { ...(await getProject(ctx, before.id)), previousStatus }
  },
})

function archiveProcedure(archive: boolean) {
  return defineProcedure({
    name: archive ? 'project.archive' : 'project.restore',
    summary: archive ? 'Archive a project. It is hidden from lists but keeps its history.' : 'Restore an archived project',
    permission: 'project:archive',
    input: z.object({ id: z.uuid() }),
    output: projectOutput,
    http: archive ? { method: 'DELETE', path: '/projects/{id}' } : { method: 'POST', path: '/projects/{id}/restore' },
    emits: [archive ? 'project.archived' : 'project.restored'],
    async handler(ctx, input) {
      const before = await loadProject(ctx, input.id, { lock: true })
      if (Boolean(before.archivedAt) === archive) return getProject(ctx, before.id)
      await ctx.tx
        .update(schema.projects)
        .set({ archivedAt: archive ? ctx.now : null, updatedAt: ctx.now })
        .where(eq(schema.projects.id, before.id))
      const action = archive ? 'project.archived' : 'project.restored'
      await ctx.audit({ action, entityType: 'project', entityId: before.id, entityLabel: before.name })
      await ctx.emit(action, await eventPayload(ctx, before.id))
      return getProject(ctx, before.id)
    },
  })
}

export const projectArchive = archiveProcedure(true)
export const projectRestore = archiveProcedure(false)

// Members

const memberOutput = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: z.enum(schema.PROJECT_MEMBER_ROLES),
  /** Per-hour overrides in the project's currency. Null when unset, or without `report:readFinancial`. */
  billableRateMinor: z.number().int().nullable(),
  costRateMinor: z.number().int().nullable(),
  /**
   * A fixed engagement cost instead of an hourly one: what this person costs
   * the project in total. Set, their time is logged at a cost rate of zero.
   */
  fixedFeeMinor: z.number().int().nullable(),
  fixedFeeOn: z.iso.date().nullable(),
  createdAt: z.date(),
})

type Member = z.infer<typeof memberOutput>

async function getMembers(ctx: ActorContext, where: ReturnType<typeof eq>, financial: boolean): Promise<Member[]> {
  const rows = await ctx.tx
    .select({ member: schema.projectMembers, name: schema.user.name, email: schema.user.email })
    .from(schema.projectMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.projectMembers.userId))
    .where(where)
    .orderBy(schema.user.name)
  return rows.map(({ member, name, email }) => ({
    id: member.id,
    projectId: member.projectId,
    userId: member.userId,
    name,
    email,
    role: member.role as Member['role'],
    billableRateMinor: financial ? member.billableRateMinor : null,
    costRateMinor: financial ? member.costRateMinor : null,
    fixedFeeMinor: financial ? member.fixedFeeMinor : null,
    fixedFeeOn: financial ? member.fixedFeeOn : null,
    createdAt: member.createdAt,
  }))
}

async function getMember(ctx: ActorContext, id: string, financial = ctx.has('report:readFinancial')): Promise<Member> {
  const [member] = await getMembers(ctx, eq(schema.projectMembers.id, id), financial)
  if (!member) throw new NotFoundError('Project member', id)
  return member
}

/** Rates are internal economics: they never go out in events. A fee is a rate. */
function memberEvent(member: Member) {
  const { billableRateMinor: _b, costRateMinor: _c, fixedFeeMinor: _f, fixedFeeOn: _fo, ...rest } = member
  return rest
}

async function insertMember(
  ctx: ActorContext,
  values: {
    projectId: string
    userId: string
    role: Member['role']
    billableRateMinor?: number | null
    costRateMinor?: number | null
    fixedFeeMinor?: number | null
    fixedFeeOn?: string | null
  },
): Promise<Member> {
  const id = newId()
  const inserted = await ctx.tx
    .insert(schema.projectMembers)
    .values({ id, organizationId: ctx.organizationId, ...values })
    .onConflictDoNothing()
    .returning({ id: schema.projectMembers.id })
  if (inserted.length === 0) {
    throw new DomainError('That person is already on this project.', 'already_member', 'userId')
  }
  const member = await getMember(ctx, id)
  await ctx.audit({
    action: 'project_member.added',
    entityType: 'project',
    entityId: values.projectId,
    entityLabel: member.name,
    changes: { role: { from: null, to: values.role } },
  })
  await ctx.emit('project_member.added', memberEvent(member))
  return member
}

export const projectMemberList = defineProcedure({
  name: 'projectMember.list',
  summary: "The people on a project, with rate overrides if you can see them",
  permission: 'project:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: z.object({ data: z.array(memberOutput) }),
  http: { method: 'GET', path: '/projects/{id}/members' },
  async handler(ctx, input) {
    await loadProject(ctx, input.id)
    return { data: await getMembers(ctx, eq(schema.projectMembers.projectId, input.id), ctx.has('report:readFinancial')) }
  },
})

const rates = {
  billableRateMinor: minorAmount.nullish(),
  costRateMinor: minorAmount.nullish(),
  /**
   * A fixed engagement cost instead of an hourly one. Set, this person's time
   * on this project is logged at a cost rate of zero and the fee is counted
   * once against the project.
   */
  fixedFeeMinor: minorAmount.nullish(),
  fixedFeeOn: z.iso.date().nullish(),
}

/** Every commercial term on a membership, for the permission escalation below. */
const RATE_FIELDS = ['billableRateMinor', 'costRateMinor', 'fixedFeeMinor', 'fixedFeeOn'] as const

export const projectMemberAdd = defineProcedure({
  name: 'projectMember.add',
  summary: 'Add someone from the organization to a project',
  permission: 'project:update',
  input: z.object({
    id: z.uuid(),
    userId: z.uuid(),
    role: z.enum(schema.PROJECT_MEMBER_ROLES).default('member'),
    ...rates,
  }),
  output: memberOutput,
  http: { method: 'POST', path: '/projects/{id}/members', successStatus: 201 },
  emits: ['project_member.added'],
  async handler(ctx, input) {
    await loadActiveProject(ctx, input.id)
    await assertMember(ctx, input.userId)
    requireFinancial(ctx, RATE_FIELDS.some((f) => input[f] != null))
    return insertMember(ctx, {
      projectId: input.id,
      userId: input.userId,
      role: input.role,
      billableRateMinor: input.billableRateMinor ?? null,
      costRateMinor: input.costRateMinor ?? null,
      fixedFeeMinor: input.fixedFeeMinor ?? null,
      fixedFeeOn: input.fixedFeeOn ?? null,
    })
  },
})

/**
 * Time already logged at an hourly cost rate, for someone about to go onto a
 * fixed fee. Those entries would be paid for twice -- once by the hour and
 * once by the fee -- so the caller has to say what should happen to them.
 *
 * Entries already at zero are not counted: they cost the project nothing
 * either way.
 */
async function costedEntries(ctx: ActorContext, projectId: string, userId: string): Promise<number> {
  const te = schema.timeEntries
  const [row] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(te)
    .where(and(eq(te.projectId, projectId), eq(te.userId, userId), sql`${te.costRateMinor} > 0`))
  return row?.n ?? 0
}

export const projectMemberUpdate = defineProcedure({
  name: 'projectMember.update',
  summary: "Change a project member's role, rate overrides, or fixed fee",
  permission: 'project:update',
  input: z.object({
    id: z.uuid(),
    role: z.enum(schema.PROJECT_MEMBER_ROLES).optional(),
    ...rates,
    /**
     * Confirms that time already logged at an hourly cost should be rewritten
     * to cost nothing, because the fee now covers it. Without it, putting
     * someone with costed time onto a fixed fee is refused rather than quietly
     * double-counting.
     */
    rebaseLoggedCost: z.boolean().optional(),
  }),
  output: memberOutput,
  http: { method: 'PATCH', path: '/project-members/{id}' },
  emits: ['project_member.updated'],
  async handler(ctx, input) {
    const { id, rebaseLoggedCost, ...fields } = input
    const [before] = await ctx.tx.select().from(schema.projectMembers).where(eq(schema.projectMembers.id, id)).limit(1)
    if (!before) throw new NotFoundError('Project member', id)
    const patch = provided(fields)
    requireFinancial(ctx, RATE_FIELDS.some((f) => f in patch))

    // Only when the fee is being switched on. Changing its amount afterwards
    // touches nothing, because the entries already cost zero.
    const startsFixedFee = patch.fixedFeeMinor != null && before.fixedFeeMinor === null
    let rebased = 0
    if (startsFixedFee) {
      const costed = await costedEntries(ctx, before.projectId, before.userId)
      if (costed > 0 && !rebaseLoggedCost) {
        throw new DomainError(
          `This person already has ${costed} time ${costed === 1 ? 'entry' : 'entries'} on this project logged at an hourly cost. ` +
            'A fixed fee would count that work twice. Confirm to rewrite those entries to cost nothing.',
          'logged_cost_would_double',
          'fixedFeeMinor',
        )
      }
      rebased = costed
    }

    const changes = diff(before as Record<string, unknown>, patch)
    if (!changes && rebased === 0) return getMember(ctx, id)

    await ctx.tx.update(schema.projectMembers).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.projectMembers.id, id))

    if (rebased > 0) {
      const te = schema.timeEntries
      await ctx.tx
        .update(te)
        .set({ costRateMinor: 0, costRateSource: 'project_member_fixed', updatedAt: ctx.now })
        .where(and(eq(te.projectId, before.projectId), eq(te.userId, before.userId), sql`${te.costRateMinor} > 0`))
    }

    const member = await getMember(ctx, id)
    await ctx.audit({
      action: 'project_member.updated',
      entityType: 'project',
      entityId: before.projectId,
      entityLabel: member.name,
      // How much history moved is the part someone will come back asking about.
      changes: { ...changes, ...(rebased > 0 ? { rebasedTimeEntries: { from: null, to: rebased } } : {}) },
    })
    await ctx.emit('project_member.updated', memberEvent(member))
    return member
  },
})

export const projectMemberRemove = defineProcedure({
  name: 'projectMember.remove',
  summary: 'Take someone off a project. Their tasks stay assigned to them.',
  permission: 'project:update',
  input: z.object({ id: z.uuid() }),
  output: z.object({ removed: z.boolean() }),
  http: { method: 'DELETE', path: '/project-members/{id}' },
  emits: ['project_member.removed'],
  async handler(ctx, input) {
    const member = await getMember(ctx, input.id, false)
    await ctx.tx.delete(schema.projectMembers).where(eq(schema.projectMembers.id, member.id))
    await ctx.audit({ action: 'project_member.removed', entityType: 'project', entityId: member.projectId, entityLabel: member.name })
    await ctx.emit('project_member.removed', memberEvent(member))
    return { removed: true }
  },
})
