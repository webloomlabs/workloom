import { asc, count, eq, max, schema } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { optionalText, provided } from '../crm/shared.ts'

/**
 * The agency's own kinds of project: "Web development", "Digital marketing".
 *
 * A type is a label and a set of defaults. The billing model a new project of
 * the type starts with -- and the period its budget is measured over -- come
 * from here; the project then owns its own, so changing a type later does not
 * rewrite projects already running.
 */

/** What every organization starts with, the first time it asks. */
export const DEFAULT_PROJECT_TYPES: ReadonlyArray<{
  name: string
  defaultBillingModel: (typeof schema.PROJECT_BILLING_MODELS)[number]
  defaultBudgetPeriod: (typeof schema.BUDGET_PERIODS)[number]
  color: string
}> = [
  { name: 'Web development', defaultBillingModel: 'fixed_price', defaultBudgetPeriod: 'total', color: '#0b8a5e' },
  { name: 'Web development + maintenance', defaultBillingModel: 'fixed_price', defaultBudgetPeriod: 'total', color: '#2563eb' },
  { name: 'Digital marketing', defaultBillingModel: 'retainer', defaultBudgetPeriod: 'month', color: '#d97706' },
  { name: 'Support and maintenance', defaultBillingModel: 'retainer', defaultBudgetPeriod: 'month', color: '#7c3aed' },
]

export const projectTypeOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  defaultBillingModel: z.enum(schema.PROJECT_BILLING_MODELS),
  defaultBudgetPeriod: z.enum(schema.BUDGET_PERIODS),
  color: z.string().nullable(),
  position: z.number().int(),
  archived: z.boolean(),
  /** How many projects are of this type. */
  projectCount: z.number().int(),
})

export type ProjectType = z.infer<typeof projectTypeOutput>
type TypeRow = typeof schema.projectTypes.$inferSelect

export async function ensureProjectTypes(ctx: ActorContext): Promise<void> {
  const [existing] = await ctx.tx.select({ n: count() }).from(schema.projectTypes)
  if ((existing?.n ?? 0) > 0) return
  for (const [i, t] of DEFAULT_PROJECT_TYPES.entries()) {
    await ctx.tx.insert(schema.projectTypes).values({ id: newId(), organizationId: ctx.organizationId, ...t, position: i + 1 }).onConflictDoNothing()
  }
}

async function present(ctx: ActorContext, row: TypeRow): Promise<ProjectType> {
  const [used] = await ctx.tx.select({ n: count() }).from(schema.projects).where(eq(schema.projects.projectTypeId, row.id))
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultBillingModel: row.defaultBillingModel as ProjectType['defaultBillingModel'],
    defaultBudgetPeriod: row.defaultBudgetPeriod as ProjectType['defaultBudgetPeriod'],
    color: row.color,
    position: row.position,
    archived: row.archivedAt !== null,
    projectCount: used?.n ?? 0,
  }
}

export async function loadProjectType(ctx: ActorContext, id: string, options: { active?: boolean } = {}): Promise<TypeRow> {
  const [row] = await ctx.tx.select().from(schema.projectTypes).where(eq(schema.projectTypes.id, id)).limit(1)
  if (!row) throw new NotFoundError('Project type', id)
  if (options.active && row.archivedAt) throw new DomainError(`"${row.name}" is archived. Choose another type.`, 'project_type_archived', 'projectTypeId')
  return row
}

const typeFields = {
  description: optionalText(2000),
  defaultBillingModel: z.enum(schema.PROJECT_BILLING_MODELS).optional(),
  defaultBudgetPeriod: z.enum(schema.BUDGET_PERIODS).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'A colour is # and six hex digits')
    .transform((v) => v.toLowerCase())
    .nullish(),
}

function assertDefaults(model: string, period: string) {
  if (model === 'fixed_price' && period !== 'total') {
    throw new DomainError('A fixed price is one sum for the whole job, so its budget is for the whole project too.', 'fixed_price_period', 'defaultBudgetPeriod')
  }
}

export const projectTypeList = defineProcedure({
  name: 'projectType.list',
  summary: "The organization's kinds of project, with the defaults each starts from",
  permission: 'project:read',
  readOnly: true,
  input: z.object({ includeArchived: z.boolean().optional() }),
  output: z.object({ data: z.array(projectTypeOutput) }),
  http: { method: 'GET', path: '/project-types' },
  async handler(ctx, input) {
    await ensureProjectTypes(ctx)
    const rows = await ctx.tx.select().from(schema.projectTypes).orderBy(asc(schema.projectTypes.position), asc(schema.projectTypes.name))
    return { data: await Promise.all(rows.filter((r) => input.includeArchived || r.archivedAt === null).map((r) => present(ctx, r))) }
  },
})

export const projectTypeCreate = defineProcedure({
  name: 'projectType.create',
  summary: 'Add a kind of project',
  permission: 'project:update',
  input: z.object({ name: z.string().trim().min(1).max(80), ...typeFields }),
  output: projectTypeOutput,
  http: { method: 'POST', path: '/project-types', successStatus: 201 },
  emits: [],
  async handler(ctx, input) {
    await ensureProjectTypes(ctx)
    const model = input.defaultBillingModel ?? 'fixed_price'
    const period = input.defaultBudgetPeriod ?? (model === 'retainer' ? 'month' : 'total')
    assertDefaults(model, period)
    const [last] = await ctx.tx.select({ position: max(schema.projectTypes.position) }).from(schema.projectTypes)
    const id = newId()
    try {
      await ctx.tx.insert(schema.projectTypes).values({
        id,
        organizationId: ctx.organizationId,
        name: input.name,
        description: input.description ?? null,
        defaultBillingModel: model,
        defaultBudgetPeriod: period,
        color: input.color ?? null,
        position: (last?.position ?? 0) + 1,
      })
    } catch (error) {
      if (String((error as { cause?: { constraint?: string } }).cause?.constraint ?? '').includes('project_types_organization_name_key')) {
        throw new DomainError(`There is already a project type called "${input.name}".`, 'project_type_exists', 'name')
      }
      throw error
    }
    const type = await present(ctx, await loadProjectType(ctx, id))
    await ctx.audit({ action: 'project_type.created', entityType: 'project_type', entityId: id, entityLabel: input.name })
    return type
  },
})

export const projectTypeUpdate = defineProcedure({
  name: 'projectType.update',
  summary: 'Rename a kind of project, change its defaults, or archive it. Projects already running keep their own settings.',
  permission: 'project:update',
  input: z.object({ id: z.uuid(), name: z.string().trim().min(1).max(80).optional(), archived: z.boolean().optional(), ...typeFields }),
  output: projectTypeOutput,
  http: { method: 'PATCH', path: '/project-types/{id}' },
  emits: [],
  async handler(ctx, input) {
    const { id, archived, ...fields } = input
    const before = await loadProjectType(ctx, id)
    const patch = provided(fields) as Partial<TypeRow>
    if (archived !== undefined) patch.archivedAt = archived ? (before.archivedAt ?? ctx.now) : null
    assertDefaults(patch.defaultBillingModel ?? before.defaultBillingModel, patch.defaultBudgetPeriod ?? before.defaultBudgetPeriod)
    const changes = diff(before as unknown as Record<string, unknown>, patch)
    if (!changes) return present(ctx, before)
    await ctx.tx.update(schema.projectTypes).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.projectTypes.id, id))
    const type = await present(ctx, await loadProjectType(ctx, id))
    await ctx.audit({ action: 'project_type.updated', entityType: 'project_type', entityId: id, entityLabel: type.name, changes })
    return type
  },
})
