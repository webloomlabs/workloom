import { z } from 'zod'
import { DomainError, type ActorContext } from '../../context.ts'
import { formatDecimal, MoneyError, parseDecimal, RATE_SCALE } from '../../money/money.ts'
import { calculate, type Calculation } from '../../tax/calculate.ts'
import { dateIn } from '../../time/index.ts'
import { loadCompany } from '../crm/companies.ts'
import { loadContact } from '../crm/contacts.ts'
import { loadDeal } from '../crm/deals.ts'
import { optionalText, organizationTimezone } from '../crm/shared.ts'
import { loadProject } from '../projects/projects.ts'
import { loadService } from './services.ts'
import { fromNumeric, percentInput, pricingRefusal, quantityInput, signedMinorAmount } from './shared.ts'
import { loadTaxRate } from './tax-rates.ts'

/**
 * What quotes and invoices share.
 *
 * The two documents differ in their dates and their states, not in how they are
 * built or priced: the same lines, the same catalogue, the same calculator. Both
 * modules go through here, so a quote and the invoice raised from it can never
 * add up differently.
 */

/** The columns every document line has, whichever document it belongs to. */
export type DocumentLineRow = {
  id: string
  position: number
  serviceId: string | null
  description: string
  quantity: string
  unitAmountMinor: number
  discountPercent: string | null
  taxRateId: string | null
  taxName: string | null
  taxRatePctSnapshot: string | null
  amountMinor: number
  lineDiscountMinor: number
  netMinor: number
  documentDiscountMinor: number
  taxMinor: number
  totalMinor: number
}

export type PricedDocument = {
  currency: string
  taxMode: string
  discountPercent: string | null
  discountAmountMinor: number | null
}

export const documentLineOutput = z.object({
  id: z.uuid(),
  position: z.number().int(),
  serviceId: z.uuid().nullable(),
  description: z.string(),
  /** Exact decimal string, up to four places. */
  quantity: z.string(),
  unitAmountMinor: z.number().int(),
  discountPercent: z.string().nullable(),
  taxRateId: z.uuid().nullable(),
  /** The tax's name and rate when it was applied to this line. */
  taxName: z.string().nullable(),
  taxRate: z.string().nullable(),
  amountMinor: z.number().int(),
  lineDiscountMinor: z.number().int(),
  netMinor: z.number().int(),
  /** This line's share of the document discount. */
  documentDiscountMinor: z.number().int(),
  taxableMinor: z.number().int(),
  taxMinor: z.number().int(),
  totalMinor: z.number().int(),
})

export type DocumentLine = z.infer<typeof documentLineOutput>

export const documentTaxOutput = z.object({
  taxRateId: z.uuid(),
  name: z.string(),
  rate: z.string(),
  amountMinor: z.number().int(),
  taxMinor: z.number().int(),
})

export function presentLine(line: DocumentLineRow): DocumentLine {
  return {
    id: line.id,
    position: line.position,
    serviceId: line.serviceId,
    description: line.description,
    quantity: fromNumeric(line.quantity),
    unitAmountMinor: line.unitAmountMinor,
    discountPercent: fromNumeric(line.discountPercent),
    taxRateId: line.taxRateId,
    taxName: line.taxName,
    taxRate: fromNumeric(line.taxRatePctSnapshot),
    amountMinor: line.amountMinor,
    lineDiscountMinor: line.lineDiscountMinor,
    netMinor: line.netMinor,
    documentDiscountMinor: line.documentDiscountMinor,
    taxableMinor: line.netMinor - line.documentDiscountMinor,
    taxMinor: line.taxMinor,
    totalMinor: line.totalMinor,
  }
}

/** One entry per tax used, in order of first use, from the lines' own snapshots. */
export function taxesFromLines(lines: DocumentLine[]): Array<z.infer<typeof documentTaxOutput>> {
  const taxes = new Map<string, z.infer<typeof documentTaxOutput>>()
  for (const line of lines) {
    if (!line.taxRateId) continue
    const tax = taxes.get(line.taxRateId) ?? { taxRateId: line.taxRateId, name: line.taxName!, rate: line.taxRate!, amountMinor: 0, taxMinor: 0 }
    tax.amountMinor += line.taxableMinor
    tax.taxMinor += line.taxMinor
    taxes.set(line.taxRateId, tax)
  }
  return [...taxes.values()]
}

/** Prices a document from its stored lines, refusing in the caller's language. */
export function priceDocument(document: PricedDocument, lines: DocumentLineRow[]): Calculation {
  try {
    return calculate({
      currency: document.currency,
      taxMode: document.taxMode as 'exclusive' | 'inclusive',
      discount:
        document.discountPercent !== null
          ? { percent: document.discountPercent }
          : document.discountAmountMinor !== null
            ? { amountMinor: document.discountAmountMinor }
            : null,
      lines: lines.map((l) => ({
        quantity: l.quantity,
        unitAmountMinor: l.unitAmountMinor,
        discountPercent: l.discountPercent,
        tax: l.taxRateId ? { key: l.taxRateId, rate: l.taxRatePctSnapshot! } : null,
      })),
    })
  } catch (error) {
    pricingRefusal(error)
  }
}

/** The computed columns of a priced line, for storing. */
export function pricedLineValues(priced: Calculation['lines'][number]) {
  return {
    amountMinor: priced.amountMinor,
    lineDiscountMinor: priced.lineDiscountMinor,
    netMinor: priced.netMinor,
    documentDiscountMinor: priced.documentDiscountMinor,
    taxMinor: priced.taxMinor,
    totalMinor: priced.totalMinor,
  }
}

/** A line that has not been priced yet; the next write prices it. */
export const UNPRICED = { amountMinor: 0, lineDiscountMinor: 0, netMinor: 0, documentDiscountMinor: 0, taxMinor: 0, totalMinor: 0 }

export const lineInput = z.object({
  /** A catalogue service. Its name, price (in the document's currency), and default tax fill whatever the line leaves out. */
  serviceId: z.uuid().nullish(),
  description: optionalText(2000),
  /** Defaults to 1. */
  quantity: quantityInput.optional(),
  /** Minor units of the document's currency; negative for a credit. */
  unitAmountMinor: signedMinorAmount.optional(),
  discountPercent: percentInput.nullish(),
  /** Omit to use the service's default tax; null for no tax. */
  taxRateId: z.uuid().nullish(),
})

export type LineInput = z.infer<typeof lineInput>

/**
 * The stored values for a new line, filled from its service where the input
 * leaves gaps. The tax's name and rate are snapshotted here, so a later change
 * to the tax rate cannot alter what the document said.
 */
export async function newLineValues(ctx: ActorContext, document: { currency: string }, input: LineInput, field = '') {
  const service = input.serviceId ? await loadService(ctx, input.serviceId, { active: true }) : null
  const description = input.description ?? (service ? service.name : null)
  if (!description) throw new DomainError('Describe the line, or choose a service.', 'description_required', `${field}description`)
  const unitAmountMinor =
    input.unitAmountMinor ?? (service && service.currency === document.currency && service.defaultPriceMinor !== null ? service.defaultPriceMinor : undefined)
  if (unitAmountMinor === undefined) {
    throw new DomainError(
      service ? `Enter a price: "${service.name}" has no standard price in ${document.currency}.` : 'Enter a unit price.',
      'unit_amount_required',
      `${field}unitAmountMinor`,
    )
  }
  const taxRateId = input.taxRateId !== undefined ? input.taxRateId : (service?.defaultTaxRateId ?? null)
  const tax = taxRateId ? await loadTaxRate(ctx, taxRateId, { active: true, field: `${field}taxRateId` }) : null
  return {
    serviceId: service?.id ?? null,
    description,
    quantity: input.quantity ?? '1',
    unitAmountMinor,
    discountPercent: input.discountPercent ?? null,
    taxRateId: tax?.id ?? null,
    taxName: tax?.name ?? null,
    taxRatePctSnapshot: tax?.rate ?? null,
    ...UNPRICED,
  }
}

/** The tax columns for a line whose tax is being changed. */
export async function taxSnapshot(ctx: ActorContext, taxRateId: string | null) {
  const tax = taxRateId ? await loadTaxRate(ctx, taxRateId, { active: true }) : null
  return { taxRateId: tax?.id ?? null, taxName: tax?.name ?? null, taxRatePctSnapshot: tax?.rate ?? null }
}

/**
 * The client, and the contact, deal, and project a document is linked to --
 * which must all belong to that client.
 */
export async function resolveLinks(
  ctx: ActorContext,
  input: { companyId?: string | null | undefined; contactId?: string | null | undefined; dealId?: string | null | undefined; projectId?: string | null | undefined },
  what = 'quote',
) {
  let companyId = input.companyId ?? null
  let deal: Awaited<ReturnType<typeof loadDeal>> | null = null
  if (input.dealId) {
    deal = await loadDeal(ctx, input.dealId)
    if (companyId && deal.companyId !== companyId) throw new DomainError('That deal belongs to a different company.', 'deal_company_mismatch', 'dealId')
    companyId = deal.companyId
  }
  if (!companyId) throw new DomainError(`Choose the client this ${what} is for.`, 'company_required', 'companyId')
  const company = await loadCompany(ctx, companyId)
  if (input.contactId) {
    const contact = await loadContact(ctx, input.contactId)
    if (contact.companyId !== companyId) throw new DomainError('That contact works for a different company.', 'contact_company_mismatch', 'contactId')
  }
  if (input.projectId) {
    const project = await loadProject(ctx, input.projectId)
    if (project.companyId !== companyId) throw new DomainError('That project is for a different client.', 'project_company_mismatch', 'projectId')
  }
  return { company, deal }
}

export function assertOneDiscount(percent: string | null | undefined, amount: number | null | undefined): void {
  if (percent != null && amount != null) {
    throw new DomainError('Give the discount as a percentage or an amount, not both.', 'one_discount', 'discountAmountMinor')
  }
}

/** Today where the organization is, which is what an issue date means. */
export async function today(ctx: ActorContext): Promise<string> {
  return dateIn(ctx.now, await organizationTimezone(ctx))
}

/** How many units of the base currency one unit of the document's currency is worth. */
export const exchangeRateInput = z.union([z.string(), z.number()]).transform((value, ctx) => {
  try {
    const scaled = parseDecimal(String(value), RATE_SCALE, { integerDigits: 10, label: 'Exchange rate' })
    if (scaled <= 0n) throw new MoneyError('Exchange rate must be greater than zero.', 'invalid_exchange_rate')
    return formatDecimal(scaled, RATE_SCALE)
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error
    ctx.addIssue({ code: 'custom', message: error.message })
    return z.NEVER
  }
})
