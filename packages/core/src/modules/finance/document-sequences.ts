import { and, eq, inArray, schema } from '@workloom/db'
import { z } from 'zod'
import { DomainError, type ActorContext } from '../../context.ts'
import { defineProcedure } from '../../registry/index.ts'
import { dateIn } from '../../time/index.ts'
import { organizationTimezone } from '../crm/shared.ts'
import { effectiveFormat, fiscalStartMonth, lockScope, sequenceSettings, DEFAULT_PREFIX, type DocumentKind } from './numbering.ts'
import { formatDocumentNumber, formatProblem, legacyFormat, sequenceScope, type SequenceReset } from './numbering-format.ts'

/**
 * How quotes, invoices, and tickets are numbered, and where each count stands.
 *
 * The format and reset rule live on the sequence's settings row; the count for
 * the current year (or for all time, for a sequence that never resets) lives on
 * its scoped row. Changing where a count stands is allowed -- an agency moving
 * to Workloom part-way through a year starts at 144, not 1 -- but never onto a
 * number that is already taken.
 */

const sequenceOutput = z.object({
  kind: z.enum(schema.DOCUMENT_KINDS),
  /** The template in use, "WL-{YYYY}-{NNNN}". */
  format: z.string(),
  reset: z.enum(schema.SEQUENCE_RESETS),
  /** The run of numbers today falls in: '' for all time, '2026', 'FY2025'. */
  scope: z.string(),
  /** The counter the next document issued today will take. */
  nextValue: z.number().int(),
  /** That next number, printed: "WL-2026-0144". */
  nextNumber: z.string(),
})

type SequenceOutput = z.infer<typeof sequenceOutput>

async function todayIn(ctx: ActorContext): Promise<string> {
  return dateIn(ctx.now, await organizationTimezone(ctx))
}

async function describe(ctx: ActorContext, kind: DocumentKind): Promise<SequenceOutput> {
  const d = schema.documentSequences
  const today = await todayIn(ctx)
  const fyStart = await fiscalStartMonth(ctx)
  const [settings] = await ctx.tx.select().from(d).where(and(eq(d.kind, kind), eq(d.scope, ''))).limit(1)
  const format = settings ? effectiveFormat(settings) : legacyFormat(DEFAULT_PREFIX[kind], 4)
  const reset = (settings?.reset ?? 'never') as SequenceReset
  const scope = sequenceScope(reset, today, fyStart)
  const [counting] = scope === '' ? [settings] : await ctx.tx.select().from(d).where(and(eq(d.kind, kind), eq(d.scope, scope))).limit(1)
  const nextValue = counting?.nextValue ?? 1
  return { kind, format, reset, scope, nextValue, nextNumber: formatDocumentNumber(format, nextValue, today, fyStart) }
}

export const documentSequenceList = defineProcedure({
  name: 'documentSequence.list',
  summary: 'How quotes, invoices, and tickets are numbered, and the next number of each',
  permission: 'organization:read',
  readOnly: true,
  input: z.object({}),
  output: z.object({ data: z.array(sequenceOutput) }),
  http: { method: 'GET', path: '/document-sequences' },
  async handler(ctx) {
    return { data: await Promise.all(schema.DOCUMENT_KINDS.map((kind) => describe(ctx, kind))) }
  },
})

/** The column a kind of document keeps its number in. */
function numberColumn(kind: DocumentKind) {
  return { invoice: schema.invoices.number, quote: schema.quotes.number, ticket: schema.tickets.number, expense: schema.expenses.number }[kind]
}

function numberTable(kind: DocumentKind) {
  return { invoice: schema.invoices, quote: schema.quotes, ticket: schema.tickets, expense: schema.expenses }[kind]
}

/** The largest stretch of numbers checked for collisions when a count is moved back. */
const COLLISION_WINDOW = 5000

export const documentSequenceUpdate = defineProcedure({
  name: 'documentSequence.update',
  // Not offered to AI assistants: Invoice numbering must stay gapless and deliberate.
  mcp: false,
  summary: 'Change how a kind of document is numbered, or where its count stands',
  permission: 'organization:update',
  input: z.object({
    kind: z.enum(schema.DOCUMENT_KINDS),
    /** A template such as "WL-{YYYY}-{NNNN}". Tokens: {YYYY}, {YY}, {FY}, and a run of N for the counter. */
    format: z.string().trim().min(1).max(60).optional(),
    reset: z.enum(schema.SEQUENCE_RESETS).optional(),
    /** The counter the next document issued today takes. Never onto a number already used. */
    nextValue: z.number().int().min(1).max(1_000_000_000).optional(),
  }),
  output: sequenceOutput,
  http: { method: 'PATCH', path: '/document-sequences/{kind}' },
  emits: [],
  async handler(ctx, input) {
    const d = schema.documentSequences
    const before = await describe(ctx, input.kind)
    const settings = await sequenceSettings(ctx, input.kind, { lock: true })
    const format = input.format ?? effectiveFormat(settings)
    const reset = input.reset ?? (settings.reset as SequenceReset)
    const problem = formatProblem(format, reset)
    if (problem) throw new DomainError(problem.message, problem.code, input.format !== undefined ? 'format' : 'reset')

    if (input.format !== undefined || input.reset !== undefined) {
      await ctx.tx
        .update(d)
        .set({ format, reset, updatedAt: ctx.now })
        .where(and(eq(d.kind, input.kind), eq(d.scope, '')))
    }

    const today = await todayIn(ctx)
    const fyStart = await fiscalStartMonth(ctx)
    const scope = sequenceScope(reset, today, fyStart)
    const counting = await lockScope(ctx, { ...settings, format, reset }, scope)
    const target = input.nextValue ?? counting.nextValue

    // Every number this sequence would hand out from the target up to where it
    // already stood -- or just the next one, when moving forward or changing
    // format -- must be free.
    const upTo = Math.max(target, Math.min(counting.nextValue - 1, target + COLLISION_WINDOW))
    const candidates: string[] = []
    for (let value = target; value <= upTo; value++) candidates.push(formatDocumentNumber(format, value, today, fyStart))
    const column = numberColumn(input.kind)
    const taken = await ctx.tx.select({ number: column }).from(numberTable(input.kind)).where(inArray(column, candidates)).limit(1)
    if (taken.length > 0) {
      throw new DomainError(
        `${taken[0]!.number} has already been issued. Start the count after it, or choose a format that cannot produce it.`,
        'number_taken',
        input.nextValue !== undefined ? 'nextValue' : 'format',
      )
    }
    if (target !== counting.nextValue) {
      await ctx.tx
        .update(d)
        .set({ nextValue: target, updatedAt: ctx.now })
        .where(and(eq(d.kind, input.kind), eq(d.scope, scope)))
    }

    const after = await describe(ctx, input.kind)
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    if (before.format !== after.format) changes.format = { from: before.format, to: after.format }
    if (before.reset !== after.reset) changes.reset = { from: before.reset, to: after.reset }
    if (before.nextValue !== after.nextValue) changes.nextValue = { from: before.nextValue, to: after.nextValue }
    if (Object.keys(changes).length > 0) {
      await ctx.audit({ action: 'document_sequence.updated', entityType: 'document_sequence', entityId: ctx.organizationId, entityLabel: input.kind, changes })
    }
    return after
  },
})
