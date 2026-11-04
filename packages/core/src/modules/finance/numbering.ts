import { and, eq, schema } from '@workloom/db'
import type { ActorContext } from '../../context.ts'
import { dateIn } from '../../time/index.ts'
import { organizationTimezone } from '../crm/shared.ts'
import { formatDocumentNumber, legacyFormat, sequenceScope, type SequenceReset } from './numbering-format.ts'

export type DocumentKind = (typeof schema.DOCUMENT_KINDS)[number]

export const DEFAULT_PREFIX: Record<DocumentKind, string> = { quote: 'Q-', invoice: 'INV-', ticket: 'T-', expense: 'EXP-' }

type SequenceRow = typeof schema.documentSequences.$inferSelect

/**
 * The settings row for a kind of document: its format and reset rule, and --
 * for a sequence that never resets -- its counter. Created with the defaults
 * the first time anything asks.
 */
export async function sequenceSettings(ctx: ActorContext, kind: DocumentKind, options: { lock?: boolean } = {}): Promise<SequenceRow> {
  const d = schema.documentSequences
  await ctx.tx.insert(d).values({ organizationId: ctx.organizationId, kind, scope: '', prefix: DEFAULT_PREFIX[kind] }).onConflictDoNothing()
  const query = ctx.tx.select().from(d).where(and(eq(d.kind, kind), eq(d.scope, '')))
  const [row] = options.lock ? await query.for('update') : await query
  return row!
}

/** The template a sequence prints with: its own format, or the one its prefix and padding imply. */
export function effectiveFormat(row: Pick<SequenceRow, 'format' | 'prefix' | 'padding'>): string {
  return row.format ?? legacyFormat(row.prefix, row.padding)
}

export async function fiscalStartMonth(ctx: ActorContext): Promise<number> {
  const [org] = await ctx.tx
    .select({ month: schema.organization.fiscalYearStartMonth })
    .from(schema.organization)
    .where(eq(schema.organization.id, ctx.organizationId))
    .limit(1)
  return org?.month ?? 1
}

/**
 * The counting row for one scope, locked for the rest of the transaction.
 * A scoped row is created on first use, starting at 1.
 */
export async function lockScope(ctx: ActorContext, settings: SequenceRow, scope: string): Promise<SequenceRow> {
  const d = schema.documentSequences
  if (scope !== '') {
    await ctx.tx
      .insert(d)
      .values({ organizationId: ctx.organizationId, kind: settings.kind, scope, prefix: settings.prefix, padding: settings.padding })
      .onConflictDoNothing()
  }
  const [row] = await ctx.tx
    .select()
    .from(d)
    .where(and(eq(d.kind, settings.kind), eq(d.scope, scope)))
    .for('update')
  return row!
}

/**
 * The next number for a document, taken inside the caller's transaction.
 *
 * The counting row is locked until the transaction ends, so concurrent issues
 * queue behind each other; if the caller rolls back, so does the increment, and
 * no number is skipped. The unique index on the document's number is the
 * backstop.
 *
 * The year in a number, and the run of numbers it counts in, come from the
 * document's own issue date -- not from today. An invoice backdated into last
 * year is numbered in last year's run.
 */
export async function issueNumber(ctx: ActorContext, kind: DocumentKind, issueDate?: string): Promise<string> {
  const date = issueDate ?? dateIn(ctx.now, await organizationTimezone(ctx))
  const settings = await sequenceSettings(ctx, kind)
  const fyStart = await fiscalStartMonth(ctx)
  const scope = sequenceScope(settings.reset as SequenceReset, date, fyStart)
  const row = await lockScope(ctx, settings, scope)
  await ctx.tx
    .update(schema.documentSequences)
    .set({ nextValue: row.nextValue + 1, updatedAt: ctx.now })
    .where(and(eq(schema.documentSequences.kind, kind), eq(schema.documentSequences.scope, scope)))
  return formatDocumentNumber(effectiveFormat(settings), row.nextValue, date, fyStart)
}
