import { eq, schema } from '@workloom/db'
import type { ActorContext } from '../../context.ts'

type DocumentKind = (typeof schema.DOCUMENT_KINDS)[number]

const DEFAULT_PREFIX: Record<DocumentKind, string> = { quote: 'Q-', invoice: 'INV-', ticket: 'T-' }

/**
 * The next number for a document, taken inside the caller's transaction.
 *
 * The sequence row is locked until the transaction ends, so concurrent issues
 * queue behind each other; if the caller rolls back, so does the increment, and
 * no number is skipped. The unique index on the document's number is the
 * backstop.
 */
export async function issueNumber(ctx: ActorContext, kind: DocumentKind): Promise<string> {
  const d = schema.documentSequences
  await ctx.tx.insert(d).values({ organizationId: ctx.organizationId, kind, prefix: DEFAULT_PREFIX[kind] }).onConflictDoNothing()
  const [row] = await ctx.tx.select().from(d).where(eq(d.kind, kind)).for('update')
  await ctx.tx.update(d).set({ nextValue: row!.nextValue + 1, updatedAt: ctx.now }).where(eq(d.kind, kind))
  return `${row!.prefix}${String(row!.nextValue).padStart(row!.padding, '0')}`
}
