import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn, timestamps } from './columns.ts'
import { companies, deals } from './crm.ts'

/**
 * Projects, milestones, and tasks.
 *
 * A project may belong to a client (a company) and may have come from a won
 * deal; an internal project has neither. Children carry `project_id` in their
 * composite foreign keys, so a task can only sit under a milestone of its own
 * project, and a dependency can only join two tasks of the same project --
 * enforced by the database, not by remembering to check.
 *
 * `client_visible` on milestones, tasks, comments, and attachments marks what a
 * client may eventually see. The MVP stores and edits the flag; the portal
 * that reads it is Phase 2. Everything defaults to internal.
 */

export const PROJECT_STATUSES = ['planning', 'in_progress', 'on_hold', 'review', 'completed', 'cancelled'] as const
export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export const PROJECT_MEMBER_ROLES = ['manager', 'member'] as const

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** The client. Null for internal work. */
    companyId: uuid('company_id'),
    /** The won deal this project delivers, if it came from one. */
    dealId: uuid('deal_id'),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('planning'),
    startDate: date('start_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),

    /** The currency of the budget and of member rate overrides. */
    currency: text('currency').notNull(),
    /** Integer minor units of `currency`. Null when there is no budget. */
    budgetMinor: bigint('budget_minor', { mode: 'number' }),
    /**
     * The price originally agreed, in `currency`.
     *
     * Deliberately not `budget_minor`, which is the internal cost ceiling: what
     * the work may cost us and what the client pays are different numbers, and
     * raising the price does not make the work cheaper. Reporting compares
     * budget against cost and contract against what has been billed.
     *
     * **This column does not move when a revision is accepted.** What the
     * project is contracted for now is this price plus every accepted row in
     * `project_revisions` -- see `contractedValue` in core. Adding the change
     * here as well would count it twice, and leave two numbers to keep in step.
     *
     * Null when the engagement is not fixed-price -- time and materials has no
     * agreed total, and a project without one cannot have a billing plan.
     */
    contractValueMinor: bigint('contract_value_minor', { mode: 'number' }),

    /** The person accountable for delivery. */
    ownerId: uuid('owner_id').references(() => user.id, { onDelete: 'set null' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('projects_organization_id_id_key').on(t.organizationId, t.id),
    // Carries the currency, so a revision or a billing stage cannot be in one
    // the project is not.
    unique('projects_organization_id_id_currency_key').on(t.organizationId, t.id, t.currency),
    index('projects_organization_status_idx').on(t.organizationId, t.status),
    index('projects_organization_company_idx').on(t.organizationId, t.companyId),
    foreignKey({
      name: 'projects_company_fk',
      columns: [t.organizationId, t.companyId],
      foreignColumns: [companies.organizationId, companies.id],
    }),
    foreignKey({
      name: 'projects_deal_fk',
      columns: [t.organizationId, t.dealId],
      foreignColumns: [deals.organizationId, deals.id],
    }),
    check('projects_status_check', sql`${t.status} in ${oneOf(PROJECT_STATUSES)}`),
    check('projects_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('projects_budget_check', sql`${t.budgetMinor} >= 0`),
    check('projects_contract_value_check', sql`${t.contractValueMinor} >= 0`),
    check('projects_completed_check', sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`),
  ],
)

/**
 * Who works on a project, and at what rates.
 *
 * Rates here override the person's defaults for this project only. Time
 * tracking (S6) resolves a rate when an entry is created and copies it onto
 * the entry, so changing a rate here never rewrites past time.
 */
export const projectMembers = pgTable(
  'project_members',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    projectId: uuid('project_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    /** What the client is charged per hour, in the project's currency. */
    billableRateMinor: bigint('billable_rate_minor', { mode: 'number' }),
    /** What an hour costs the agency, in the project's currency. */
    costRateMinor: bigint('cost_rate_minor', { mode: 'number' }),
    /**
     * A fixed engagement cost: what this person costs the project in total,
     * rather than per hour. Set, their time still tracks but carries a cost
     * rate of zero, so the hours stay visible without being paid for twice.
     * Minor units of the project's currency, as the rates above are.
     */
    fixedFeeMinor: bigint('fixed_fee_minor', { mode: 'number' }),
    /** The day the fee counts from, as an expense has `incurred_on`. */
    fixedFeeOn: date('fixed_fee_on', { mode: 'string' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('project_members_organization_project_user_key').on(t.organizationId, t.projectId, t.userId),
    foreignKey({
      name: 'project_members_project_fk',
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    check('project_members_role_check', sql`${t.role} in ${oneOf(PROJECT_MEMBER_ROLES)}`),
    check('project_members_rates_check', sql`${t.billableRateMinor} >= 0 and ${t.costRateMinor} >= 0`),
    check('project_members_fixed_fee_check', sql`${t.fixedFeeMinor} >= 0`),
    // A date without a fee dates nothing.
    check('project_members_fixed_fee_date_check', sql`${t.fixedFeeOn} is null or ${t.fixedFeeMinor} is not null`),
  ],
)

export const milestones = pgTable(
  'milestones',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    dueDate: date('due_date', { mode: 'string' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    clientVisible: boolean('client_visible').notNull().default(false),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('milestones_organization_id_id_key').on(t.organizationId, t.id),
    // The target of tasks' (organization, project, milestone) foreign key.
    unique('milestones_organization_project_id_key').on(t.organizationId, t.projectId, t.id),
    foreignKey({
      name: 'milestones_project_fk',
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
  ],
)

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    projectId: uuid('project_id').notNull(),
    milestoneId: uuid('milestone_id'),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('todo'),
    priority: text('priority').notNull().default('normal'),
    assigneeId: uuid('assignee_id').references(() => user.id, { onDelete: 'set null' }),
    dueDate: date('due_date', { mode: 'string' }),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    estimateMinutes: integer('estimate_minutes'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    clientVisible: boolean('client_visible').notNull().default(false),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('tasks_organization_id_id_key').on(t.organizationId, t.id),
    // The target of dependencies', comments', and attachments' foreign keys.
    unique('tasks_organization_project_id_key').on(t.organizationId, t.projectId, t.id),
    index('tasks_organization_project_status_idx').on(t.organizationId, t.projectId, t.status),
    index('tasks_organization_assignee_status_idx').on(t.organizationId, t.assigneeId, t.status),
    foreignKey({
      name: 'tasks_project_fk',
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    // Including project_id: a task cannot sit under another project's milestone.
    foreignKey({
      name: 'tasks_milestone_fk',
      columns: [t.organizationId, t.projectId, t.milestoneId],
      foreignColumns: [milestones.organizationId, milestones.projectId, milestones.id],
    }),
    check('tasks_status_check', sql`${t.status} in ${oneOf(TASK_STATUSES)}`),
    check('tasks_priority_check', sql`${t.priority} in ${oneOf(TASK_PRIORITIES)}`),
    check('tasks_estimate_check', sql`${t.estimateMinutes} >= 0`),
    check('tasks_completed_check', sql`(${t.status} = 'done') = (${t.completedAt} is not null)`),
  ],
)

/**
 * `task_id` cannot be completed until `depends_on_task_id` is done or cancelled.
 *
 * Both foreign keys include `project_id`, so dependencies never cross projects.
 * Cycles are refused by the service under a project-level lock: a CHECK cannot
 * see other rows, and a trigger would hide the rule from anyone reading the
 * application.
 */
export const taskDependencies = pgTable(
  'task_dependencies',
  {
    ...tenantColumn,
    projectId: uuid('project_id').notNull(),
    taskId: uuid('task_id').notNull(),
    dependsOnTaskId: uuid('depends_on_task_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'task_dependencies_pkey', columns: [t.organizationId, t.taskId, t.dependsOnTaskId] }),
    index('task_dependencies_organization_depends_on_idx').on(t.organizationId, t.dependsOnTaskId),
    foreignKey({
      name: 'task_dependencies_task_fk',
      columns: [t.organizationId, t.projectId, t.taskId],
      foreignColumns: [tasks.organizationId, tasks.projectId, tasks.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'task_dependencies_depends_on_fk',
      columns: [t.organizationId, t.projectId, t.dependsOnTaskId],
      foreignColumns: [tasks.organizationId, tasks.projectId, tasks.id],
    }).onDelete('cascade'),
    check('task_dependencies_not_self_check', sql`${t.taskId} <> ${t.dependsOnTaskId}`),
  ],
)

/**
 * Discussion on a task, or -- with no task -- an update on the project itself.
 * A client-visible project comment is what the portal will show as a project
 * update; everything else is internal.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    projectId: uuid('project_id').notNull(),
    taskId: uuid('task_id'),
    authorId: uuid('author_id').references(() => user.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    clientVisible: boolean('client_visible').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('comments_organization_id_id_key').on(t.organizationId, t.id),
    index('comments_organization_project_task_idx').on(t.organizationId, t.projectId, t.taskId),
    foreignKey({
      name: 'comments_project_fk',
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    foreignKey({
      name: 'comments_task_fk',
      columns: [t.organizationId, t.projectId, t.taskId],
      foreignColumns: [tasks.organizationId, tasks.projectId, tasks.id],
    }).onDelete('cascade'),
  ],
)

/**
 * Files on a task or a project. The bytes live in object storage under
 * `storage_key`; this row is the only way to reach them, and downloads go
 * through a short-lived signed URL issued after a permission check.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    projectId: uuid('project_id').notNull(),
    taskId: uuid('task_id'),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Generated, never derived from the filename. */
    storageKey: text('storage_key').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => user.id, { onDelete: 'set null' }),
    clientVisible: boolean('client_visible').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('attachments_organization_id_id_key').on(t.organizationId, t.id),
    index('attachments_organization_project_task_idx').on(t.organizationId, t.projectId, t.taskId),
    uniqueIndex('attachments_storage_key_key').on(t.storageKey),
    foreignKey({
      name: 'attachments_project_fk',
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    foreignKey({
      name: 'attachments_task_fk',
      columns: [t.organizationId, t.projectId, t.taskId],
      foreignColumns: [tasks.organizationId, tasks.projectId, tasks.id],
    }).onDelete('cascade'),
    check('attachments_size_check', sql`${t.sizeBytes} >= 0`),
  ],
)
