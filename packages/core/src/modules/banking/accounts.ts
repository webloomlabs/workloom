import { and, asc, desc, eq, isNull, isNotNull, lt, ne, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import {
  actingUserId,
  baseCurrency,
  currencyCode,
  optionalText,
  pageInput,
  pageOutput,
  paginate,
  provided,
  queryFlag,
  requiredText,
} from '../crm/shared.ts'

/**
 * The accounts money sits in.
 *
 * A setting more than daily work: an agency has three or four of these and
 * changes them almost never. What makes the page worth opening is the second
 * half of each row -- how much is in it, and how much of it nobody has
 * explained yet. That second number is the one that tells an agency their books
 * are drifting, so it is on the list rather than behind a report.
 *
 * `currentBalanceMinor` is not computed here. It is maintained by the trigger
 * in migration 0023 and read straight off the row, so the list stays O(1)
 * against an account with ten years of statements in it.
 */

type AccountRow = typeof schema.bankAccounts.$inferSelect

export const bankAccountOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(schema.BANK_ACCOUNT_KINDS),
  currency: z.string().length(3),
  institution: z.string().nullable(),
  accountIdentifier: z.string().nullable(),
  openingBalanceMinor: z.number().int(),
  openingBalanceOn: z.iso.date(),
  /** Opening plus every line. Derived in the database; never written here. */
  currentBalanceMinor: z.number().int(),
  isDefault: z.boolean(),
  /** Lines still waiting for a person. The number this module exists to drive down. */
  unexplainedCount: z.number().int(),
  unexplainedMinor: z.number().int(),
  oldestUnexplainedOn: z.iso.date().nullable(),
  lastReconciledOn: z.iso.date().nullable(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type BankAccount = z.infer<typeof bankAccountOutput>

type AccountJoin = {
  account: AccountRow
  unexplainedCount: number | null
  unexplainedMinor: number | null
  oldestUnexplainedOn: string | null
  lastReconciledOn: string | null
}

function presentAccount(row: AccountJoin): BankAccount {
  const a = row.account
  return {
    id: a.id,
    name: a.name,
    kind: a.kind as BankAccount['kind'],
    currency: a.currency,
    institution: a.institution,
    accountIdentifier: a.accountIdentifier,
    openingBalanceMinor: a.openingBalanceMinor,
    openingBalanceOn: a.openingBalanceOn,
    currentBalanceMinor: a.currentBalanceMinor,
    isDefault: a.isDefault,
    unexplainedCount: row.unexplainedCount ?? 0,
    unexplainedMinor: row.unexplainedMinor ?? 0,
    oldestUnexplainedOn: row.oldestUnexplainedOn,
    lastReconciledOn: row.lastReconciledOn,
    archivedAt: a.archivedAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

/**
 * The account, with what is still unexplained and when it last balanced.
 *
 * Correlated subqueries rather than joins onto grouped sets: both are covered
 * by an index, and neither multiplies the account rows.
 */
function selectAccounts(ctx: ActorContext) {
  const a = schema.bankAccounts
  const t = schema.bankTransactions
  const r = schema.bankReconciliations
  const outstanding = sql`${t.bankAccountId} = ${a.id} and ${t.status} in ('unexplained', 'part_explained')`
  return ctx.tx
    .select({
      account: a,
      unexplainedCount: sql<number>`(select count(*)::int from ${t} where ${outstanding})`,
      // What is unexplained, net of the part already matched.
      unexplainedMinor: sql<number>`(select coalesce(sum(${t.amountMinor} - ${t.matchedMinor}), 0)::int from ${t} where ${outstanding})`,
      oldestUnexplainedOn: sql<string | null>`(select min(${t.bookedOn}) from ${t} where ${outstanding})`,
      lastReconciledOn: sql<string | null>`(select max(${r.statementEndOn}) from ${r} where ${r.bankAccountId} = ${a.id})`,
    })
    .from(a)
}

export async function getBankAccount(ctx: ActorContext, id: string): Promise<BankAccount> {
  const [row] = await selectAccounts(ctx).where(eq(schema.bankAccounts.id, id)).limit(1)
  if (!row) throw new NotFoundError('Bank account', id)
  return presentAccount(row)
}

export async function loadBankAccount(
  ctx: ActorContext,
  id: string,
  options: { lock?: boolean } = {},
): Promise<AccountRow> {
  const query = ctx.tx.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, id)).limit(1)
  const [row] = await (options.lock ? query.for('update') : query)
  if (!row) throw new NotFoundError('Bank account', id)
  return row
}

/** An archived account takes no new lines. */
export function refuseArchivedAccount(account: AccountRow): void {
  if (account.archivedAt) {
    throw new DomainError('That account is archived. Restore it first.', 'account_archived', 'bankAccountId')
  }
}

/**
 * Leaves exactly one default. The partial unique index would refuse a second,
 * so the old one is stood down in the same transaction rather than relying on
 * the caller to have noticed.
 */
async function standDownOtherDefaults(ctx: ActorContext, keep: string): Promise<void> {
  await ctx.tx
    .update(schema.bankAccounts)
    .set({ isDefault: false, updatedAt: ctx.now })
    .where(and(eq(schema.bankAccounts.isDefault, true), ne(schema.bankAccounts.id, keep)))
}

// Reads

export const bankAccountList = defineProcedure({
  name: 'bankAccount.list',
  summary: 'The agency’s accounts, with what is in them and what is still unexplained',
  permission: 'bankAccount:read',
  readOnly: true,
  input: z.object({
    kind: z.enum(schema.BANK_ACCOUNT_KINDS).optional(),
    currency: currencyCode.optional(),
    /** Archived accounts are hidden unless asked for. */
    archived: queryFlag,
    /** Only accounts with lines nobody has explained. */
    needsAttention: queryFlag,
    ...pageInput,
  }),
  output: pageOutput(bankAccountOutput),
  http: { method: 'GET', path: '/bank-accounts' },
  async handler(ctx, input) {
    const a = schema.bankAccounts
    const t = schema.bankTransactions
    const conditions: Array<SQL | undefined> = [
      input.archived ? isNotNull(a.archivedAt) : isNull(a.archivedAt),
      input.kind ? eq(a.kind, input.kind) : undefined,
      input.currency ? eq(a.currency, input.currency) : undefined,
      input.needsAttention
        ? sql`exists (select 1 from ${t} where ${t.bankAccountId} = ${a.id} and ${t.status} in ('unexplained', 'part_explained'))`
        : undefined,
      input.cursor ? lt(a.id, input.cursor) : undefined,
    ]
    // The default first, then by name: this list is read, not scrolled.
    const rows = await selectAccounts(ctx)
      .where(and(...conditions))
      .orderBy(desc(a.isDefault), asc(a.name), desc(a.id))
      .limit(input.limit + 1)
    return paginate(rows.map(presentAccount), input.limit)
  },
})

export const bankAccountGet = defineProcedure({
  name: 'bankAccount.get',
  summary: 'One account, its balance, and when it last reconciled',
  permission: 'bankAccount:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: bankAccountOutput,
  http: { method: 'GET', path: '/bank-accounts/{id}' },
  async handler(ctx, input) {
    return getBankAccount(ctx, input.id)
  },
})

// Writes

const accountFields = {
  kind: z.enum(schema.BANK_ACCOUNT_KINDS).optional(),
  institution: optionalText(200),
  /** Enough to recognise it. Never the full number -- see the schema. */
  accountIdentifier: optionalText(60),
  isDefault: z.boolean().optional(),
}

export const bankAccountCreate = defineProcedure({
  name: 'bankAccount.create',
  summary: 'Add a bank, card, or cash account',
  permission: 'bankAccount:create',
  input: z.object({
    name: requiredText(120, 'Name'),
    /** Fixed for the life of the account; defaults to the organization’s own. */
    currency: currencyCode.optional(),
    /**
     * The statement balance this account is measured from, and its date.
     * Signed: a credit card opens negative.
     */
    openingBalanceMinor: z.number().int().optional(),
    openingBalanceOn: z.iso.date(),
    ...accountFields,
  }),
  output: bankAccountOutput,
  http: { method: 'POST', path: '/bank-accounts', successStatus: 201 },
  emits: ['bank_account.created'],
  async handler(ctx, input) {
    const currency = input.currency ?? (await baseCurrency(ctx))
    const opening = input.openingBalanceMinor ?? 0

    // The first account is the default, because otherwise nothing is and every
    // form asks a question with one possible answer.
    const [existing] = await ctx.tx
      .select({ id: schema.bankAccounts.id })
      .from(schema.bankAccounts)
      .where(isNull(schema.bankAccounts.archivedAt))
      .limit(1)
    const isDefault = input.isDefault ?? !existing

    const id = newId()
    if (isDefault) await standDownOtherDefaults(ctx, id)
    await ctx.tx.insert(schema.bankAccounts).values({
      id,
      organizationId: ctx.organizationId,
      name: input.name,
      kind: input.kind ?? 'bank',
      currency,
      institution: input.institution ?? null,
      accountIdentifier: input.accountIdentifier ?? null,
      openingBalanceMinor: opening,
      openingBalanceOn: input.openingBalanceOn,
      // The anchor is the balance until a line lands and the trigger takes over.
      currentBalanceMinor: opening,
      isDefault,
      createdBy: actingUserId(ctx),
    })

    const account = await getBankAccount(ctx, id)
    await ctx.audit({ action: 'bank_account.created', entityType: 'bank_account', entityId: id, entityLabel: account.name })
    await ctx.emit('bank_account.created', account)
    return account
  },
})

export const bankAccountUpdate = defineProcedure({
  name: 'bankAccount.update',
  summary: 'Rename an account, or change how it is identified',
  permission: 'bankAccount:update',
  input: z.object({
    id: z.uuid(),
    name: requiredText(120, 'Name').optional(),
    /**
     * Only while the account has no lines. Afterwards it is refused: moving the
     * anchor rewrites every reconciliation measured from it.
     */
    openingBalanceMinor: z.number().int().optional(),
    openingBalanceOn: z.iso.date().optional(),
    ...accountFields,
  }),
  output: bankAccountOutput,
  http: { method: 'PATCH', path: '/bank-accounts/{id}' },
  emits: ['bank_account.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadBankAccount(ctx, id, { lock: true })
    const patch = provided(fields)

    const movesAnchor =
      (patch.openingBalanceMinor !== undefined && patch.openingBalanceMinor !== before.openingBalanceMinor) ||
      (patch.openingBalanceOn !== undefined && patch.openingBalanceOn !== before.openingBalanceOn)
    if (movesAnchor) {
      const [line] = await ctx.tx
        .select({ id: schema.bankTransactions.id })
        .from(schema.bankTransactions)
        .where(eq(schema.bankTransactions.bankAccountId, id))
        .limit(1)
      if (line) {
        throw new DomainError(
          'This account has transactions. The opening balance is what every reconciliation is measured from, so it can no longer be moved.',
          'opening_balance_locked',
          'openingBalanceMinor',
        )
      }
    }

    if (patch.isDefault === true) await standDownOtherDefaults(ctx, id)
    if (patch.isDefault === false && before.isDefault) {
      throw new DomainError(
        'Make another account the default instead of clearing this one.',
        'default_required',
        'isDefault',
      )
    }

    const changes = diff(before as unknown as Record<string, unknown>, patch as Partial<AccountRow>)
    if (!changes) return getBankAccount(ctx, id)

    await ctx.tx
      .update(schema.bankAccounts)
      .set({ ...(patch as Partial<AccountRow>), updatedAt: ctx.now })
      .where(eq(schema.bankAccounts.id, id))

    const account = await getBankAccount(ctx, id)
    await ctx.audit({
      action: 'bank_account.updated',
      entityType: 'bank_account',
      entityId: id,
      entityLabel: account.name,
      changes,
    })
    await ctx.emit('bank_account.updated', account)
    return account
  },
})

export const bankAccountArchive = defineProcedure({
  name: 'bankAccount.archive',
  summary: 'Close an account, keeping everything that went through it',
  permission: 'bankAccount:archive',
  input: z.object({ id: z.uuid() }),
  output: bankAccountOutput,
  http: { method: 'POST', path: '/bank-accounts/{id}/archive' },
  emits: ['bank_account.archived'],
  async handler(ctx, input) {
    const before = await loadBankAccount(ctx, input.id, { lock: true })
    if (before.archivedAt) throw new DomainError('That account is already archived.', 'already_archived')

    // Archiving is not a way to make unexplained lines go away.
    const [outstanding] = await ctx.tx
      .select({ id: schema.bankTransactions.id })
      .from(schema.bankTransactions)
      .where(
        and(
          eq(schema.bankTransactions.bankAccountId, input.id),
          sql`${schema.bankTransactions.status} in ('unexplained', 'part_explained')`,
        ),
      )
      .limit(1)
    if (outstanding) {
      throw new DomainError(
        'This account still has transactions nobody has explained. Explain or ignore them before closing it.',
        'account_unexplained',
      )
    }

    await ctx.tx
      .update(schema.bankAccounts)
      .set({ archivedAt: ctx.now, isDefault: false, updatedAt: ctx.now })
      .where(eq(schema.bankAccounts.id, input.id))

    const account = await getBankAccount(ctx, input.id)
    await ctx.audit({ action: 'bank_account.archived', entityType: 'bank_account', entityId: input.id, entityLabel: account.name })
    await ctx.emit('bank_account.archived', account)
    return account
  },
})

export const bankAccountRestore = defineProcedure({
  name: 'bankAccount.restore',
  summary: 'Reopen an archived account',
  permission: 'bankAccount:archive',
  input: z.object({ id: z.uuid() }),
  output: bankAccountOutput,
  http: { method: 'POST', path: '/bank-accounts/{id}/restore' },
  emits: ['bank_account.restored'],
  async handler(ctx, input) {
    const before = await loadBankAccount(ctx, input.id, { lock: true })
    if (!before.archivedAt) throw new DomainError('That account is not archived.', 'not_archived')

    await ctx.tx
      .update(schema.bankAccounts)
      .set({ archivedAt: null, updatedAt: ctx.now })
      .where(eq(schema.bankAccounts.id, input.id))

    const account = await getBankAccount(ctx, input.id)
    await ctx.audit({ action: 'bank_account.restored', entityType: 'bank_account', entityId: input.id, entityLabel: account.name })
    await ctx.emit('bank_account.restored', account)
    return account
  },
})
