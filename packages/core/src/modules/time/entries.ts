import { alias, and, desc, eq, gte, isNotNull, isNull, lt, lte, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { ConflictError, DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { dateIn, MAX_ENTRY_SECONDS } from '../../time/index.ts'
import { actingUserId, optionalFlag, optionalText, organizationTimezone, provided, queryFlag, violatedConstraint } from '../crm/shared.ts'
import { loadActiveProject, loadProject } from '../projects/projects.ts'
import { loadTask } from '../projects/tasks.ts'
import { memberName, snapshotRates } from './rates.ts'

/**
 * Time entries and timers.
 *
 * Everyone with `timeEntry:*` works on their own time. Other people's time is
 * invisible without `timeEntryAll:read` -- answered as "not found", like any
 * record the caller cannot see -- and unchangeable without `timeEntryAll:manage`.
 */

type EntryRow = typeof schema.timeEntries.$inferSelect

const rateSource = z.enum(schema.RATE_SOURCES)

export const timeEntryOutput = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  userName: z.string(),
  projectId: z.uuid(),
  projectName: z.string(),
  taskId: z.uuid().nullable(),
  taskTitle: z.string().nullable(),
  description: z.string().nullable(),
  /** The day the time counts towards, in the organization's time zone. */
  spentOn: z.iso.date(),
  /** Set for timers. Null for time logged by hand. */
  startedAt: z.date().nullable(),
  endedAt: z.date().nullable(),
  /** Null while the timer is running. */
  durationSeconds: z.number().int().nullable(),
  running: z.boolean(),
  billable: z.boolean(),
  /** True once an invoice line has billed this time. Billed time cannot be edited or deleted. */
  invoiced: z.boolean(),
  /** The currency of the rates: the project's, when the entry was logged. */
  currency: z.string().length(3),
  /**
   * Per-hour rates copied onto the entry when it was logged, and where each
   * came from. Null when nothing defined one, or without `report:readFinancial`.
   */
  billableRateMinor: z.number().int().nullable(),
  billableRateSource: rateSource.nullable(),
  costRateMinor: z.number().int().nullable(),
  costRateSource: rateSource.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type TimeEntry = z.infer<typeof timeEntryOutput>

const person = alias(schema.user, 'time_entry_user')

function selectEntries(ctx: ActorContext) {
  const t = schema.timeEntries
  return ctx.tx
    .select({ entry: t, userName: person.name, projectName: schema.projects.name, taskTitle: schema.tasks.title })
    .from(t)
    .innerJoin(person, eq(person.id, t.userId))
    .innerJoin(schema.projects, eq(schema.projects.id, t.projectId))
    .leftJoin(schema.tasks, eq(schema.tasks.id, t.taskId))
}

function present(
  row: { entry: EntryRow; userName: string; projectName: string; taskTitle: string | null },
  options: { financial: boolean },
): TimeEntry {
  const { entry } = row
  const financial = options.financial
  return {
    id: entry.id,
    userId: entry.userId,
    userName: row.userName,
    projectId: entry.projectId,
    projectName: row.projectName,
    taskId: entry.taskId,
    taskTitle: row.taskTitle,
    description: entry.description,
    spentOn: entry.spentOn,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationSeconds: entry.durationSeconds,
    running: entry.durationSeconds === null,
    billable: entry.billable,
    invoiced: entry.invoiceLineId !== null,
    currency: entry.currency,
    billableRateMinor: financial ? entry.billableRateMinor : null,
    billableRateSource: financial ? (entry.billableRateSource as TimeEntry['billableRateSource']) : null,
    costRateMinor: financial ? entry.costRateMinor : null,
    costRateSource: financial ? (entry.costRateSource as TimeEntry['costRateSource']) : null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

async function getEntry(ctx: ActorContext, id: string): Promise<TimeEntry> {
  const [row] = await selectEntries(ctx).where(eq(schema.timeEntries.id, id)).limit(1)
  if (!row) throw new NotFoundError('Time entry', id)
  return present(row, { financial: ctx.has('report:readFinancial') })
}

/** Rates are internal economics: they never go out in events. */
async function eventPayload(ctx: ActorContext, id: string) {
  const [row] = await selectEntries(ctx).where(eq(schema.timeEntries.id, id)).limit(1)
  const { billableRateMinor: _b, billableRateSource: _bs, costRateMinor: _c, costRateSource: _cs, ...rest } = present(row!, { financial: false })
  return rest
}

const isOwn = (ctx: ActorContext, entry: { userId: string }) => entry.userId === actingUserId(ctx)

/** An entry the caller may see. Someone else's is "not found" without `timeEntryAll:read`. */
async function loadVisibleEntry(ctx: ActorContext, id: string, options: { lock?: boolean } = {}): Promise<EntryRow> {
  const query = ctx.tx.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, id)).limit(1)
  const [row] = options.lock ? await query.for('update') : await query
  if (!row || (!isOwn(ctx, row) && !ctx.has('timeEntryAll:read'))) throw new NotFoundError('Time entry', id)
  return row
}

/** An entry the caller may change: their own, or anyone's with `timeEntryAll:manage`. */
async function loadChangeableEntry(ctx: ActorContext, id: string): Promise<EntryRow> {
  const entry = await loadVisibleEntry(ctx, id, { lock: true })
  if (!isOwn(ctx, entry)) ctx.require('timeEntryAll:manage')
  // Billed time is part of an invoice. Removing the line from a draft invoice
  // releases it; an issued invoice cannot be changed at all.
  if (entry.invoiceLineId) {
    throw new DomainError('This time has been billed on an invoice, so it can no longer be changed.', 'time_entry_invoiced')
  }
  return entry
}

/** The person a timer belongs to. System and job actors have no time of their own. */
function requirePerson(ctx: ActorContext): string {
  const userId = actingUserId(ctx)
  if (!userId) throw new DomainError('Only a person can track their own time.', 'no_person')
  return userId
}

/**
 * The project and task time is being logged against. Either may be given; a
 * task implies its project, and a task from a different project is refused.
 */
async function resolveWork(ctx: ActorContext, input: { projectId?: string | null | undefined; taskId?: string | null | undefined }) {
  let projectId = input.projectId ?? null
  if (input.taskId) {
    const task = await loadTask(ctx, input.taskId)
    if (projectId && task.projectId !== projectId) {
      throw new DomainError('That task belongs to a different project.', 'task_project_mismatch', 'taskId')
    }
    projectId = task.projectId
  }
  if (!projectId) throw new DomainError('Choose a project or a task.', 'project_required', 'projectId')
  const project = await loadActiveProject(ctx, projectId)
  return { project, taskId: input.taskId ?? null }
}

/** Unique violations on the running-timer index mean another timer won the race. */
async function onlyOneTimer<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (violatedConstraint(error) === 'time_entries_one_running_timer_key') {
      throw new ConflictError('A timer is already running. Stop it before starting another.')
    }
    throw error
  }
}

const seconds = z
  .number()
  .int('Whole seconds.')
  .min(60, 'Log at least a minute.')
  .max(MAX_ENTRY_SECONDS, 'One entry can be at most 24 hours. Split longer work across days.')

const work = {
  projectId: z.uuid().nullish(),
  taskId: z.uuid().nullish(),
  description: optionalText(2_000),
  /** Defaults to whether the project has a client: internal work is not billable. */
  billable: z.boolean().optional(),
}

// Reads

export const timeEntryList = defineProcedure({
  name: 'timeEntry.list',
  summary: "Time entries, newest first. Without timeEntryAll:read, only the caller's own.",
  permission: 'timeEntry:read',
  readOnly: true,
  input: z.object({
    userId: z.uuid().optional(),
    /** Only the caller's own entries (or, for an API key, its owner's). */
    mine: queryFlag,
    projectId: z.uuid().optional(),
    taskId: z.uuid().optional(),
    /** Inclusive calendar dates, compared with `spentOn`. */
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    billable: optionalFlag,
    running: optionalFlag,
    /** Only time that an invoice has billed, or only time that none has. */
    invoiced: optionalFlag,
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.uuid().optional(),
  }),
  output: z.object({ data: z.array(timeEntryOutput), nextCursor: z.uuid().nullable() }),
  http: { method: 'GET', path: '/time-entries' },
  async handler(ctx, input) {
    const t = schema.timeEntries
    const self = actingUserId(ctx)
    let userId = input.mine ? (self ?? undefined) : input.userId
    if (!ctx.has('timeEntryAll:read')) {
      if (userId && userId !== self) ctx.require('timeEntryAll:read')
      userId = self ?? '00000000-0000-0000-0000-000000000000'
    }
    if (input.projectId) await loadProject(ctx, input.projectId)
    if (input.taskId) await loadTask(ctx, input.taskId)

    const conditions: Array<SQL | undefined> = [
      userId ? eq(t.userId, userId) : undefined,
      input.projectId ? eq(t.projectId, input.projectId) : undefined,
      input.taskId ? eq(t.taskId, input.taskId) : undefined,
      input.from ? gte(t.spentOn, input.from) : undefined,
      input.to ? lte(t.spentOn, input.to) : undefined,
      input.billable === undefined ? undefined : eq(t.billable, input.billable),
      input.running === undefined ? undefined : input.running ? isNull(t.durationSeconds) : isNotNull(t.durationSeconds),
      input.invoiced === undefined ? undefined : input.invoiced ? isNotNull(t.invoiceLineId) : isNull(t.invoiceLineId),
      input.cursor ? lt(t.id, input.cursor) : undefined,
    ]
    const rows = await selectEntries(ctx)
      .where(and(...conditions))
      .orderBy(desc(t.id))
      .limit(input.limit + 1)
    const financial = ctx.has('report:readFinancial')
    const data = rows.slice(0, input.limit).map((row) => present(row, { financial }))
    return { data, nextCursor: rows.length > input.limit ? (data.at(-1)?.id ?? null) : null }
  },
})

export const timeEntryGet = defineProcedure({
  name: 'timeEntry.get',
  summary: 'One time entry',
  permission: 'timeEntry:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: timeEntryOutput,
  http: { method: 'GET', path: '/time-entries/{id}' },
  async handler(ctx, input) {
    await loadVisibleEntry(ctx, input.id)
    return getEntry(ctx, input.id)
  },
})

// Logging by hand

export const timeEntryCreate = defineProcedure({
  name: 'timeEntry.create',
  summary: "Log time by hand. Rates are resolved now and copied onto the entry.",
  permission: 'timeEntry:create',
  input: z.object({
    ...work,
    /** Whose time. Defaults to the caller; anyone else's needs timeEntryAll:manage. */
    userId: z.uuid().optional(),
    /** Defaults to today in the organization's time zone. */
    spentOn: z.iso.date().optional(),
    durationSeconds: seconds,
  }),
  output: timeEntryOutput,
  http: { method: 'POST', path: '/time-entries', successStatus: 201 },
  emits: ['time_entry.created'],
  async handler(ctx, input) {
    const self = actingUserId(ctx)
    const userId = input.userId ?? requirePerson(ctx)
    if (userId !== self) {
      ctx.require('timeEntryAll:manage')
      await memberName(ctx, userId)
    }
    const { project, taskId } = await resolveWork(ctx, input)
    const rates = await snapshotRates(ctx, project, userId)

    const id = newId()
    await ctx.tx.insert(schema.timeEntries).values({
      id,
      organizationId: ctx.organizationId,
      userId,
      projectId: project.id,
      taskId,
      description: input.description ?? null,
      spentOn: input.spentOn ?? dateIn(ctx.now, await organizationTimezone(ctx)),
      durationSeconds: input.durationSeconds,
      billable: input.billable ?? project.companyId !== null,
      currency: project.currency,
      ...rates,
      createdBy: self,
    })
    const entry = await getEntry(ctx, id)
    await ctx.audit({ action: 'time_entry.created', entityType: 'time_entry', entityId: id, entityLabel: `${entry.userName} · ${entry.projectName}` })
    await ctx.emit('time_entry.created', await eventPayload(ctx, id))
    return entry
  },
})

export const timeEntryUpdate = defineProcedure({
  name: 'timeEntry.update',
  summary: 'Edit a time entry. Moving it to another project resolves its rates again for that project.',
  permission: 'timeEntry:update',
  input: z.object({
    id: z.uuid(),
    ...work,
    spentOn: z.iso.date().optional(),
    /** Only for a stopped timer or a manual entry. */
    durationSeconds: seconds.optional(),
    /** Only for a running timer: when it really started. */
    startedAt: z.coerce.date().optional(),
  }),
  output: timeEntryOutput,
  http: { method: 'PATCH', path: '/time-entries/{id}' },
  emits: ['time_entry.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadChangeableEntry(ctx, id)
    await loadActiveProject(ctx, before.projectId)
    const patch = provided({
      description: fields.description,
      spentOn: fields.spentOn,
      durationSeconds: fields.durationSeconds,
      billable: fields.billable,
    }) as Partial<EntryRow>
    const running = before.durationSeconds === null

    if (fields.durationSeconds !== undefined && running) {
      throw new DomainError('Stop the timer before changing how long it ran.', 'timer_running', 'durationSeconds')
    }
    if (fields.startedAt !== undefined) {
      if (!running) throw new DomainError('Only a running timer can have its start moved. Change the duration instead.', 'timer_not_running', 'startedAt')
      if (fields.startedAt > ctx.now) throw new DomainError('A timer cannot start in the future.', 'started_in_future', 'startedAt')
      patch.startedAt = fields.startedAt
      patch.spentOn ??= dateIn(fields.startedAt, await organizationTimezone(ctx))
    }

    // Moving the work: a task alone implies its project.
    const moving = fields.projectId !== undefined || fields.taskId !== undefined
    if (moving) {
      const { project, taskId } = await resolveWork(ctx, {
        projectId: fields.projectId ?? (fields.taskId ? undefined : before.projectId),
        taskId: fields.taskId === undefined ? (fields.projectId && fields.projectId !== before.projectId ? null : before.taskId) : fields.taskId,
      })
      patch.taskId = taskId
      if (project.id !== before.projectId) {
        // Different project, different currency and overrides: the old rates would be wrong.
        Object.assign(patch, { projectId: project.id, currency: project.currency, ...(await snapshotRates(ctx, project, before.userId)) })
      }
    }

    const changes = diff(before as Record<string, unknown>, patch)
    if (!changes) return getEntry(ctx, id)

    await ctx.tx.update(schema.timeEntries).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.timeEntries.id, id))
    const entry = await getEntry(ctx, id)
    // Rates are recorded in the audit log, which is itself restricted; they stay out of events.
    await ctx.audit({ action: 'time_entry.updated', entityType: 'time_entry', entityId: id, entityLabel: `${entry.userName} · ${entry.projectName}`, changes })
    await ctx.emit('time_entry.updated', await eventPayload(ctx, id))
    return entry
  },
})

export const timeEntryDelete = defineProcedure({
  name: 'timeEntry.delete',
  summary: 'Delete a time entry, or discard a running timer',
  permission: 'timeEntry:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/time-entries/{id}' },
  emits: ['time_entry.deleted'],
  async handler(ctx, input) {
    const before = await loadChangeableEntry(ctx, input.id)
    await loadActiveProject(ctx, before.projectId)
    const payload = await eventPayload(ctx, before.id)
    await ctx.tx.delete(schema.timeEntries).where(eq(schema.timeEntries.id, before.id))
    await ctx.audit({
      action: 'time_entry.deleted',
      entityType: 'time_entry',
      entityId: before.id,
      entityLabel: `${payload.userName} · ${payload.projectName}`,
      changes: { durationSeconds: { from: before.durationSeconds, to: null } },
    })
    await ctx.emit('time_entry.deleted', payload)
    return { deleted: true }
  },
})

// Timers

async function runningTimer(ctx: ActorContext, userId: string, options: { lock?: boolean } = {}): Promise<EntryRow | undefined> {
  const t = schema.timeEntries
  const query = ctx.tx
    .select()
    .from(t)
    .where(and(eq(t.userId, userId), isNotNull(t.startedAt), isNull(t.endedAt)))
    .limit(1)
  const [row] = options.lock ? await query.for('update') : await query
  return row
}

async function stop(ctx: ActorContext, entry: EntryRow): Promise<TimeEntry> {
  const startedAt = entry.startedAt!
  // A start moved later than the clock (or clock skew) must not make time negative.
  const endedAt = ctx.now > startedAt ? ctx.now : startedAt
  const durationSeconds = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000)
  await ctx.tx
    .update(schema.timeEntries)
    .set({ endedAt, durationSeconds, updatedAt: ctx.now })
    .where(eq(schema.timeEntries.id, entry.id))
  const stopped = await getEntry(ctx, entry.id)
  await ctx.audit({
    action: 'time_entry.stopped',
    entityType: 'time_entry',
    entityId: entry.id,
    entityLabel: `${stopped.userName} · ${stopped.projectName}`,
    changes: { durationSeconds: { from: null, to: durationSeconds } },
  })
  await ctx.emit('time_entry.stopped', await eventPayload(ctx, entry.id))
  return stopped
}

export const timerGet = defineProcedure({
  name: 'timer.get',
  summary: "The caller's running timer, if there is one",
  permission: 'timeEntry:read',
  readOnly: true,
  input: z.object({}),
  output: z.object({ entry: timeEntryOutput.nullable() }),
  http: { method: 'GET', path: '/timer' },
  async handler(ctx) {
    const userId = actingUserId(ctx)
    const running = userId ? await runningTimer(ctx, userId) : undefined
    return { entry: running ? await getEntry(ctx, running.id) : null }
  },
})

export const timerStart = defineProcedure({
  name: 'timer.start',
  summary: 'Start a timer. A timer already running is stopped first: a person has one clock.',
  permission: 'timeEntry:create',
  input: z.object(work),
  output: z.object({ entry: timeEntryOutput, stopped: timeEntryOutput.nullable() }),
  http: { method: 'POST', path: '/timer', successStatus: 201 },
  emits: ['time_entry.started', 'time_entry.stopped'],
  async handler(ctx, input) {
    const userId = requirePerson(ctx)
    const { project, taskId } = await resolveWork(ctx, input)

    return onlyOneTimer(async () => {
      // Locking the running timer queues concurrent starts behind this one.
      // The unique index settles whatever the lock cannot: a second request
      // that saw no running timer fails to insert rather than creating two.
      const previous = await runningTimer(ctx, userId, { lock: true })
      const stopped = previous ? await stop(ctx, previous) : null

      const id = newId()
      await ctx.tx.insert(schema.timeEntries).values({
        id,
        organizationId: ctx.organizationId,
        userId,
        projectId: project.id,
        taskId,
        description: input.description ?? null,
        spentOn: dateIn(ctx.now, await organizationTimezone(ctx)),
        startedAt: ctx.now,
        billable: input.billable ?? project.companyId !== null,
        currency: project.currency,
        ...(await snapshotRates(ctx, project, userId)),
        createdBy: userId,
      })
      const entry = await getEntry(ctx, id)
      await ctx.audit({ action: 'time_entry.started', entityType: 'time_entry', entityId: id, entityLabel: `${entry.userName} · ${entry.projectName}` })
      await ctx.emit('time_entry.started', await eventPayload(ctx, id))
      return { entry, stopped }
    })
  },
})

export const timerStop = defineProcedure({
  name: 'timer.stop',
  summary: "Stop the caller's running timer, or with an id, someone else's (timeEntryAll:manage)",
  permission: 'timeEntry:update',
  input: z.object({ id: z.uuid().optional() }),
  output: timeEntryOutput,
  http: { method: 'POST', path: '/timer/stop' },
  emits: ['time_entry.stopped'],
  async handler(ctx, input) {
    // Deliberately allowed on an archived project: a timer must always be stoppable.
    const entry = input.id ? await loadChangeableEntry(ctx, input.id) : await runningTimer(ctx, requirePerson(ctx), { lock: true })
    if (!entry || entry.durationSeconds !== null) {
      throw new DomainError('There is no running timer to stop.', 'no_running_timer')
    }
    return stop(ctx, entry)
  },
})

// Rollups

const totalsOutput = z.object({
  seconds: z.number().int(),
  billableSeconds: z.number().int(),
  /** Billable time worth its snapshotted rate, per entry, rounded half away from zero. Null without report:readFinancial. */
  billableValueMinor: z.number().int().nullable(),
  /** All time, billable or not, at its snapshotted cost rate. Null without report:readFinancial. */
  costMinor: z.number().int().nullable(),
  /** Billable time with no billable rate: value the totals above cannot include. */
  unratedBillableSeconds: z.number().int(),
  /** Time with no cost rate. */
  unratedCostSeconds: z.number().int(),
})

const summaryOutput = z.object({
  projectId: z.uuid(),
  currency: z.string().length(3),
  totals: totalsOutput,
  byPerson: z.array(totalsOutput.extend({ userId: z.uuid(), name: z.string() })),
  byTask: z.array(
    totalsOutput.extend({
      /** Null for time logged against the project itself. */
      taskId: z.uuid().nullable(),
      title: z.string().nullable(),
      estimateMinutes: z.number().int().nullable(),
    }),
  ),
  /** Timers still running. Their time is not in the totals until they stop. */
  runningTimers: z.number().int(),
})

export const timeEntrySummary = defineProcedure({
  name: 'timeEntry.summary',
  summary: "A project's logged time, by person and by task, with its value if you can see money",
  permission: 'timeEntryAll:read',
  readOnly: true,
  input: z.object({ id: z.uuid(), from: z.iso.date().optional(), to: z.iso.date().optional() }),
  output: summaryOutput,
  http: { method: 'GET', path: '/projects/{id}/time' },
  async handler(ctx, input) {
    const project = await loadProject(ctx, input.id)
    const t = schema.timeEntries
    const financial = ctx.has('report:readFinancial')
    const where = and(
      eq(t.projectId, project.id),
      isNotNull(t.durationSeconds),
      input.from ? gte(t.spentOn, input.from) : undefined,
      input.to ? lte(t.spentOn, input.to) : undefined,
    )
    // Plain SQL names: an aliased table interpolated into a template loses its alias.
    const measures = {
      seconds: sql<number>`coalesce(sum(duration_seconds), 0)::int`,
      billableSeconds: sql<number>`coalesce(sum(duration_seconds) filter (where billable), 0)::int`,
      billableValueMinor: sql<number>`coalesce(sum(round(duration_seconds::numeric * billable_rate_minor / 3600)) filter (where billable), 0)::bigint`,
      costMinor: sql<number>`coalesce(sum(round(duration_seconds::numeric * cost_rate_minor / 3600)), 0)::bigint`,
      unratedBillableSeconds: sql<number>`coalesce(sum(duration_seconds) filter (where billable and billable_rate_minor is null), 0)::int`,
      unratedCostSeconds: sql<number>`coalesce(sum(duration_seconds) filter (where cost_rate_minor is null), 0)::int`,
    }
    const shape = (row: { seconds: number; billableSeconds: number; billableValueMinor: number | string; costMinor: number | string; unratedBillableSeconds: number; unratedCostSeconds: number }) => ({
      seconds: row.seconds,
      billableSeconds: row.billableSeconds,
      billableValueMinor: financial ? Number(row.billableValueMinor) : null,
      costMinor: financial ? Number(row.costMinor) : null,
      unratedBillableSeconds: row.unratedBillableSeconds,
      unratedCostSeconds: row.unratedCostSeconds,
    })

    const [[totals], byPerson, byTask, [running]] = await Promise.all([
      ctx.tx.select(measures).from(t).where(where),
      ctx.tx
        .select({ userId: t.userId, name: schema.user.name, ...measures })
        .from(t)
        .innerJoin(schema.user, eq(schema.user.id, t.userId))
        .where(where)
        .groupBy(t.userId, schema.user.name)
        .orderBy(desc(sql`sum(duration_seconds)`)),
      ctx.tx
        .select({ taskId: t.taskId, title: schema.tasks.title, estimateMinutes: schema.tasks.estimateMinutes, ...measures })
        .from(t)
        .leftJoin(schema.tasks, eq(schema.tasks.id, t.taskId))
        .where(where)
        .groupBy(t.taskId, schema.tasks.title, schema.tasks.estimateMinutes)
        .orderBy(desc(sql`sum(duration_seconds)`)),
      ctx.tx
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(and(eq(t.projectId, project.id), isNull(t.durationSeconds))),
    ])

    return {
      projectId: project.id,
      currency: project.currency,
      totals: shape(totals!),
      byPerson: byPerson.map((row) => ({ userId: row.userId, name: row.name, ...shape(row) })),
      byTask: byTask.map((row) => ({ taskId: row.taskId, title: row.title, estimateMinutes: row.estimateMinutes, ...shape(row) })),
      runningTimers: running?.n ?? 0,
    }
  },
})
