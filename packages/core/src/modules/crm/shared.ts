import { and, eq, schema } from '@workloom/db'
import { z } from 'zod'
import { DomainError, type ActorContext } from '../../context.ts'
import { isCurrencyCode } from '../../money/currency.ts'

/**
 * Optional free text. Trimmed; an empty string clears the field.
 *
 * On updates the three states mean different things: `undefined` leaves the
 * field alone, `null` or `""` clears it, and anything else replaces it.
 */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish()

export const requiredText = (max: number, label: string) =>
  z.string().trim().min(1, `${label} is required.`).max(max)

export const optionalEmail = z
  .string()
  .trim()
  .max(320)
  .transform((v) => (v === '' ? null : v.toLowerCase()))
  .pipe(z.email('Enter a valid email address.').nullable())
  .nullish()

/**
 * A web address, normalised to http(s). "example.com" becomes
 * "https://example.com".
 *
 * The scheme check is a security control, not tidiness: websites are rendered
 * as links, and a stored `javascript:` URL would run in the browser of whoever
 * clicks it.
 */
export const optionalWebsite = z
  .string()
  .trim()
  .max(2048)
  .transform((value, ctx) => {
    if (value === '') return null
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
    try {
      const url = new URL(candidate)
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.')) {
        return url.pathname === '/' && !url.search && !url.hash ? url.origin : url.toString()
      }
    } catch {
      // Falls through to the issue below.
    }
    ctx.addIssue({ code: 'custom', message: 'Enter a web address such as example.com.' })
    return z.NEVER
  })
  .nullish()

export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCurrencyCode, 'Use a three-letter ISO 4217 currency code, such as AUD.')

/** Integer minor units: cents, not dollars. */
export const minorAmount = z
  .number()
  .int('Amounts are integer minor units, e.g. 1250050 for 12,500.50.')
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)

const flag = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])

/** A boolean that also accepts "true"/"false", since GET inputs arrive as query strings. */
export const queryFlag = flag.default(false)

/**
 * The same, left undefined when absent -- for filters that are off unless
 * given, and for updates, where absent means "unchanged".
 *
 * Not `optionalFlag`: in Zod 4 a default still applies inside
 * `.optional()`, so an omitted field would arrive as `false`.
 */
export const optionalFlag = flag.optional()

export const pageInput = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** The `nextCursor` of the previous page. */
  cursor: z.uuid().optional(),
}

export const searchInput = z.string().trim().max(200).optional()

/** A LIKE pattern matching `q` anywhere, with its wildcards escaped. */
export function contains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * Keyset pagination over UUIDv7 ids, newest first. Callers fetch `limit + 1`
 * rows; the extra row only signals that another page exists.
 */
export function paginate<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null }
}

export const pageOutput = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.uuid().nullable() })

/** The person behind the request: the user, or the owner of the API key. */
export function actingUserId(ctx: ActorContext): string | null {
  if (ctx.actor.type === 'user') return ctx.actor.id
  if (ctx.actor.type === 'apiKey') return ctx.actor.userId
  return null
}

/**
 * Owners must belong to the organization.
 *
 * `member` is an auth table outside row-level security, so the organization
 * predicate here is doing real work: without it, any user id in the whole
 * installation would be accepted as an owner.
 */
export async function assertMember(ctx: ActorContext, userId: string | null | undefined): Promise<void> {
  if (!userId) return
  const [row] = await ctx.tx
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, userId)))
    .limit(1)
  if (!row) {
    throw new DomainError('The owner must be a member of this organization.', 'owner_not_member', 'ownerId')
  }
}

export async function baseCurrency(ctx: ActorContext): Promise<string> {
  const [org] = await ctx.tx
    .select({ baseCurrency: schema.organization.baseCurrency })
    .from(schema.organization)
    .where(eq(schema.organization.id, ctx.organizationId))
    .limit(1)
  return org?.baseCurrency ?? 'AUD'
}

/** The constraint a Postgres error violated, looking through driver wrappers. */
export function violatedConstraint(error: unknown): string | undefined {
  let current = error as { code?: string; constraint?: string; cause?: unknown } | undefined
  for (let depth = 0; current && depth < 4; depth++) {
    if (typeof current.code === 'string' && /^23\d{3}$/.test(current.code)) return current.constraint
    current = current.cause as typeof current
  }
  return undefined
}

/** Maps the unique-email index onto a message for the person who typed it. */
export async function withDuplicateEmailCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (violatedConstraint(error) === 'contacts_organization_email_key') {
      throw new DomainError('A contact with this email address already exists.', 'duplicate_email', 'email')
    }
    throw error
  }
}

export function refuseArchived(row: { archivedAt: Date | null }, entity: string): void {
  if (row.archivedAt) {
    throw new DomainError(`This ${entity} is archived. Restore it first.`, 'archived')
  }
}

/** Keeps only the keys whose input was provided, so `undefined` means "unchanged". */
export function provided<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>
}
