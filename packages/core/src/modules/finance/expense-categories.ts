import { asc, count, eq, max, schema } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { defineProcedure } from '../../registry/index.ts'
import { provided } from '../crm/shared.ts'
import { ensureExpenseCategories } from './expenses.ts'

/**
 * The agency's own expense categories.
 *
 * Each says how the tax pack treats what is filed under it: deductible in the
 * year, not deductible, or capital (claimed through allowances instead).
 * Categories are archived, never deleted, so an old expense keeps the one it
 * was filed under.
 */

export const expenseCategoryOutput = z.object({
  key: z.string(),
  name: z.string(),
  taxTreatment: z.enum(schema.EXPENSE_TAX_TREATMENTS),
  position: z.number().int(),
  archived: z.boolean(),
  /** How many expenses are filed under it. */
  expenseCount: z.number().int(),
})

type CategoryRow = typeof schema.expenseCategories.$inferSelect

async function present(ctx: ActorContext, row: CategoryRow) {
  const [used] = await ctx.tx.select({ n: count() }).from(schema.expenses).where(eq(schema.expenses.category, row.key))
  return {
    key: row.key,
    name: row.name,
    taxTreatment: row.taxTreatment as (typeof schema.EXPENSE_TAX_TREATMENTS)[number],
    position: row.position,
    archived: row.archivedAt !== null,
    expenseCount: used?.n ?? 0,
  }
}

async function loadCategory(ctx: ActorContext, key: string): Promise<CategoryRow> {
  await ensureExpenseCategories(ctx)
  const [row] = await ctx.tx.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.key, key)).limit(1).for('update')
  if (!row) throw new NotFoundError('Expense category', key)
  return row
}

/** A key made from a name: "Meta ads" becomes "meta_ads". */
export function categoryKey(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

export const expenseCategoryList = defineProcedure({
  name: 'expenseCategory.list',
  summary: "The organization's expense categories, in order",
  permission: 'expense:read',
  readOnly: true,
  input: z.object({ includeArchived: z.boolean().optional() }),
  output: z.object({ data: z.array(expenseCategoryOutput) }),
  http: { method: 'GET', path: '/expense-categories' },
  async handler(ctx, input) {
    await ensureExpenseCategories(ctx)
    const rows = await ctx.tx.select().from(schema.expenseCategories).orderBy(asc(schema.expenseCategories.position), asc(schema.expenseCategories.name))
    const visible = input.includeArchived ? rows : rows.filter((r) => r.archivedAt === null)
    return { data: await Promise.all(visible.map((r) => present(ctx, r))) }
  },
})

export const expenseCategoryCreate = defineProcedure({
  name: 'expenseCategory.create',
  summary: 'Add an expense category',
  permission: 'expense:update',
  input: z.object({
    name: z.string().trim().min(1).max(80),
    /** A short stable slug. Made from the name when left out. */
    key: z.string().trim().regex(/^[a-z0-9_]{1,40}$/, 'Lowercase letters, digits and underscores').optional(),
    taxTreatment: z.enum(schema.EXPENSE_TAX_TREATMENTS).default('deductible'),
  }),
  output: expenseCategoryOutput,
  http: { method: 'POST', path: '/expense-categories', successStatus: 201 },
  emits: [],
  async handler(ctx, input) {
    await ensureExpenseCategories(ctx)
    const key = input.key ?? categoryKey(input.name)
    if (!key) throw new DomainError('Give the category a name with letters or digits in it.', 'category_key_required', 'name')
    const [existing] = await ctx.tx.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.key, key)).limit(1)
    if (existing) throw new DomainError(`There is already a category "${existing.name}" (${key}).`, 'category_exists', 'name')
    const [last] = await ctx.tx.select({ position: max(schema.expenseCategories.position) }).from(schema.expenseCategories)
    await ctx.tx.insert(schema.expenseCategories).values({
      organizationId: ctx.organizationId,
      key,
      name: input.name,
      taxTreatment: input.taxTreatment,
      position: (last?.position ?? 0) + 1,
    })
    const category = await present(ctx, await loadCategory(ctx, key))
    await ctx.audit({ action: 'expense_category.created', entityType: 'expense_category', entityLabel: `${input.name} (${key})` })
    return category
  },
})

export const expenseCategoryUpdate = defineProcedure({
  name: 'expenseCategory.update',
  summary: 'Rename an expense category, change how the tax pack treats it, or archive or restore it',
  permission: 'expense:update',
  input: z.object({
    key: z.string().max(40),
    name: z.string().trim().min(1).max(80).optional(),
    taxTreatment: z.enum(schema.EXPENSE_TAX_TREATMENTS).optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    archived: z.boolean().optional(),
  }),
  output: expenseCategoryOutput,
  http: { method: 'PATCH', path: '/expense-categories/{key}' },
  emits: [],
  async handler(ctx, input) {
    const before = await loadCategory(ctx, input.key)
    const { key, archived, ...fields } = input
    if (archived && key === 'other') throw new DomainError('"Other" is where everything uncategorised goes, so it stays.', 'category_required')
    const patch: Partial<CategoryRow> = provided(fields) as Partial<CategoryRow>
    if (archived !== undefined) patch.archivedAt = archived ? (before.archivedAt ?? ctx.now) : null
    const changes = diff(before as unknown as Record<string, unknown>, patch)
    if (!changes) return present(ctx, before)
    await ctx.tx.update(schema.expenseCategories).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.expenseCategories.key, key))
    const category = await present(ctx, await loadCategory(ctx, key))
    await ctx.audit({ action: 'expense_category.updated', entityType: 'expense_category', entityLabel: `${category.name} (${key})`, changes })
    return category
  },
})
