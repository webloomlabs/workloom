import { eq, schema } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../audit.ts'
import { optionalText, provided } from './crm/shared.ts'
import { DomainError, NotFoundError } from '../context.ts'
import { defineProcedure } from '../registry/index.ts'

const organizationOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  baseCurrency: z.string().length(3),
  timezone: z.string(),
  dateFormat: z.string(),
  /** What quotes and invoices are issued as, and how they are paid. */
  legalName: z.string().nullable(),
  billingAddress: z.string().nullable(),
  taxNumber: z.string().nullable(),
  paymentInstructions: z.string().nullable(),
  /** Days from issue to due on a new invoice. */
  paymentTermsDays: z.number().int(),
})

export const organizationGet = defineProcedure({
  name: 'organization.get',
  summary: 'This organization and its settings',
  permission: 'organization:read',
  readOnly: true,
  input: z.object({}),
  output: organizationOutput,
  http: { method: 'GET', path: '/organization' },
  async handler(ctx) {
    const [org] = await ctx.tx
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, ctx.organizationId))
      .limit(1)
    if (!org) throw new NotFoundError('Organization', ctx.organizationId)
    return org
  },
})

export const organizationUpdate = defineProcedure({
  name: 'organization.update',
  summary: 'Change organization settings',
  permission: 'organization:update',
  input: z.object({
    name: z.string().min(1).max(200).optional(),
    /**
     * ISO 4217. Changing it does not convert existing records: every
     * financial document stores its own currency and the rate captured when
     * it was issued, so history stays interpretable.
     */
    baseCurrency: z.string().length(3).regex(/^[A-Z]{3}$/).optional(),
    /** IANA zone. Drives every "overdue" and "due today" calculation. */
    timezone: z.string().min(1).max(64).optional(),
    dateFormat: z.string().min(1).max(32).optional(),

    /** The issuer as it appears on a document, and how the client pays. */
    legalName: optionalText(200),
    billingAddress: optionalText(2000),
    taxNumber: optionalText(60),
    paymentInstructions: optionalText(2000),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
  }),
  output: organizationOutput,
  http: { method: 'PATCH', path: '/organization' },
  emits: ['organization.updated'],
  async handler(ctx, input) {
    const [before] = await ctx.tx
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, ctx.organizationId))
      .limit(1)
    if (!before) throw new NotFoundError('Organization', ctx.organizationId)

    if (input.timezone && !isValidTimeZone(input.timezone)) {
      throw new DomainError(`Unknown time zone: ${input.timezone}`, 'unknown_timezone', 'timezone')
    }

    const changes = diff(before as unknown as Record<string, unknown>, provided(input))
    if (!changes) return before

    const [after] = await ctx.tx
      .update(schema.organization)
      .set(provided(input))
      .where(eq(schema.organization.id, ctx.organizationId))
      .returning()

    await ctx.audit({
      action: 'organization.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      entityLabel: after?.name ?? before.name,
      changes,
    })
    await ctx.emit('organization.updated', { ...after!, changes })

    return after!
  },
})

/**
 * Validated against the runtime's own zone database rather than a list we
 * would have to maintain. A bad zone here silently shifts every due-date
 * calculation in the organization.
 */
function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}
