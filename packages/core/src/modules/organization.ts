import { env, receiptReaderSettings } from '@workloom/config'
import { eq, schema } from '@workloom/db'
import { isOneOf, storage } from '@workloom/storage'
import { z } from 'zod'
import { diff } from '../audit.ts'
import { optionalText, provided } from './crm/shared.ts'
import { DomainError, NotFoundError, type ActorContext } from '../context.ts'
import { newId } from '../ids.ts'
import { defineProcedure } from '../registry/index.ts'
import { DATE_FORMATS } from './finance/pdf.ts'

/** A printed logo: small, and a raster the PDF renderer can draw. */
export const LOGO_MAX_BYTES = 1024 * 1024

const paymentDetail = z.object({
  label: z.string().trim().min(1, 'Name the detail').max(40),
  value: z.string().trim().min(1, 'Give the detail a value').max(120),
})

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
  /** The month the financial year starts: 1 for January, 4 for April. */
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  /** Whether a printed logo has been uploaded. */
  hasLogo: z.boolean(),
  brandColor: z.string().nullable(),
  /** Bank details, printed as a box on every invoice. */
  paymentDetails: z.array(paymentDetail),
  invoiceNotesDefault: z.string().nullable(),
  invoiceTermsDefault: z.string().nullable(),
  quoteTermsDefault: z.string().nullable(),
  documentFooter: z.string().nullable(),
  /** Whether tax paid on expenses is claimed back. When not, it counts as part of the cost. */
  reclaimsInputTax: z.boolean(),
  /** Whether receipts are sent to an AI model to be read, from Telegram or the expense form. */
  receiptReadingEnabled: z.boolean(),
  /** Whether this installation can read receipts at all: a provider's key is configured. */
  receiptReadingAvailable: z.boolean(),
  /** Who reads them here: the provider and model, such as "OpenAI · gpt-6-luna". Null without a key. */
  receiptReader: z.object({ provider: z.enum(['anthropic', 'openai', 'gemini', 'groq']), name: z.string(), model: z.string() }).nullable(),
})

type OrganizationRow = typeof schema.organization.$inferSelect

const PROVIDER_NAMES = { anthropic: 'Anthropic Claude', openai: 'OpenAI', gemini: 'Google Gemini', groq: 'Groq' } as const

/** Which provider and model read receipts on this installation, or null. The key itself never leaves here. */
function receiptReader() {
  const settings = receiptReaderSettings(env)
  return settings ? { provider: settings.provider, name: PROVIDER_NAMES[settings.provider], model: settings.model } : null
}

function present(org: OrganizationRow) {
  const reader = receiptReader()
  return { ...org, hasLogo: org.logoKey !== null, receiptReadingAvailable: reader !== null, receiptReader: reader }
}

async function loadOrganization(ctx: ActorContext): Promise<OrganizationRow> {
  const [org] = await ctx.tx.select().from(schema.organization).where(eq(schema.organization.id, ctx.organizationId)).limit(1)
  if (!org) throw new NotFoundError('Organization', ctx.organizationId)
  return org
}

export const organizationGet = defineProcedure({
  name: 'organization.get',
  summary: 'This organization and its settings',
  permission: 'organization:read',
  readOnly: true,
  input: z.object({}),
  output: organizationOutput,
  http: { method: 'GET', path: '/organization' },
  async handler(ctx) {
    return present(await loadOrganization(ctx))
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
    dateFormat: z.enum(DATE_FORMATS).optional(),

    /** The issuer as it appears on a document, and how the client pays. */
    legalName: optionalText(200),
    billingAddress: optionalText(2000),
    taxNumber: optionalText(60),
    paymentInstructions: optionalText(2000),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),

    /** 1 for a January year, 4 for an April one. Numbering resets and the tax pack follow it. */
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    /** The accent on printed documents, "#0b8a5e". */
    brandColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'A colour is # and six hex digits, like #0b8a5e')
      .transform((v) => v.toLowerCase())
      .nullish(),
    /** Bank details, in the order they print. */
    paymentDetails: z.array(paymentDetail).max(8, 'At most eight payment details').optional(),
    invoiceNotesDefault: optionalText(5000),
    invoiceTermsDefault: optionalText(5000),
    quoteTermsDefault: optionalText(5000),
    /** The last line of every printed page. */
    documentFooter: optionalText(200),
    reclaimsInputTax: z.boolean().optional(),
    /** Send receipts to an AI model to be read. Needs a provider's key on the installation. */
    receiptReadingEnabled: z.boolean().optional(),
  }),
  output: organizationOutput,
  http: { method: 'PATCH', path: '/organization' },
  emits: ['organization.updated'],
  async handler(ctx, input) {
    const before = await loadOrganization(ctx)

    if (input.timezone && !isValidTimeZone(input.timezone)) {
      throw new DomainError(`Unknown time zone: ${input.timezone}`, 'unknown_timezone', 'timezone')
    }
    if (input.receiptReadingEnabled && !before.receiptReadingEnabled && !receiptReader()) {
      throw new DomainError(
        'Reading receipts needs an AI provider key on this installation: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY.',
        'ai_unavailable',
        'receiptReadingEnabled',
      )
    }

    const changes = diff(before as unknown as Record<string, unknown>, provided(input))
    if (!changes) return present(before)

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
    await ctx.emit('organization.updated', { ...present(after!), changes })

    return present(after!)
  },
})

export const organizationUploadLogo = defineProcedure({
  name: 'organization.uploadLogo',
  summary: 'Upload the logo printed on quotes and invoices (multipart/form-data; PNG or JPEG, up to 1 MB)',
  permission: 'organization:update',
  input: z.object({ file: z.file() }),
  output: organizationOutput,
  http: { method: 'POST', path: '/organization/logo', body: 'multipart' },
  rateLimit: 'expensive',
  emits: ['organization.updated'],
  async handler(ctx, input) {
    const before = await loadOrganization(ctx)
    if (input.file.size === 0) throw new DomainError('That file is empty.', 'file_empty', 'file')
    if (input.file.size > LOGO_MAX_BYTES) throw new DomainError('A logo can be at most 1 MB.', 'file_too_large', 'file')
    const bytes = Buffer.from(await input.file.arrayBuffer())
    // The bytes decide, not the name: the PDF renderer draws PNG and JPEG only.
    const type = isOneOf(bytes, ['image/png', 'image/jpeg'])
    if (!type) throw new DomainError('Upload the logo as a PNG or JPEG image.', 'file_type', 'file')

    const key = `${ctx.organizationId}/branding/logo-${newId()}`
    await storage().put(key, bytes, { contentType: type, filename: type === 'image/png' ? 'logo.png' : 'logo.jpg' })
    ctx.afterRollback(() => storage().delete(key))
    const [after] = await ctx.tx.update(schema.organization).set({ logoKey: key }).where(eq(schema.organization.id, ctx.organizationId)).returning()
    if (before.logoKey) {
      const old = before.logoKey
      ctx.afterCommit(() => storage().delete(old))
    }
    const changes = { logo: { from: before.logoKey ? 'uploaded' : null, to: 'uploaded' } }
    await ctx.audit({ action: 'organization.logo_uploaded', entityType: 'organization', entityId: ctx.organizationId, entityLabel: after!.name, changes })
    await ctx.emit('organization.updated', { ...present(after!), changes })
    return present(after!)
  },
})

export const organizationRemoveLogo = defineProcedure({
  name: 'organization.removeLogo',
  summary: 'Remove the logo printed on quotes and invoices',
  permission: 'organization:update',
  input: z.object({}),
  output: organizationOutput,
  http: { method: 'DELETE', path: '/organization/logo' },
  emits: ['organization.updated'],
  async handler(ctx) {
    const before = await loadOrganization(ctx)
    if (!before.logoKey) return present(before)
    const old = before.logoKey
    const [after] = await ctx.tx.update(schema.organization).set({ logoKey: null }).where(eq(schema.organization.id, ctx.organizationId)).returning()
    ctx.afterCommit(() => storage().delete(old))
    const changes = { logo: { from: 'uploaded', to: null } }
    await ctx.audit({ action: 'organization.logo_removed', entityType: 'organization', entityId: ctx.organizationId, entityLabel: after!.name, changes })
    await ctx.emit('organization.updated', { ...present(after!), changes })
    return present(after!)
  },
})

/** The organization's logo, for its own pages to show. Null when there is none. */
export async function organizationLogo(ctx: ActorContext): Promise<{ bytes: Buffer; contentType: string } | null> {
  const org = await loadOrganization(ctx)
  if (!org.logoKey) return null
  const bytes = await storage().get(org.logoKey)
  const type = isOneOf(bytes, ['image/png', 'image/jpeg'])
  return type ? { bytes, contentType: type } : null
}

export const organizationLogoGet = defineProcedure({
  name: 'organization.logo',
  summary: 'The printed logo, base64-encoded, or null when there is none',
  permission: 'organization:read',
  readOnly: true,
  input: z.object({}),
  output: z.object({ logo: z.object({ contentType: z.enum(['image/png', 'image/jpeg']), base64: z.string() }).nullable() }),
  http: { method: 'GET', path: '/organization/logo' },
  async handler(ctx) {
    const logo = await organizationLogo(ctx)
    return { logo: logo ? { contentType: logo.contentType as 'image/png' | 'image/jpeg', base64: logo.bytes.toString('base64') } : null }
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
