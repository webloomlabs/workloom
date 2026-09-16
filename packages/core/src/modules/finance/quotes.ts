import { alias, and, asc, desc, eq, ilike, lt, max, or, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { ConflictError, DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { convert, formatDecimal, parseDecimal, RATE_SCALE, toSafeNumber } from '../../money/money.ts'
import { defineProcedure } from '../../registry/index.ts'
import { addDays } from '../../time/index.ts'
import { loadCompany } from '../crm/companies.ts'
import { loadDeal } from '../crm/deals.ts'
import {
  actingUserId,
  baseCurrency,
  contains,
  currencyCode,
  minorAmount,
  optionalText,
  pageInput,
  pageOutput,
  paginate,
  provided,
  refuseArchived,
  requiredText,
  searchInput,
} from '../crm/shared.ts'
import {
  assertOneDiscount,
  documentLineOutput,
  documentTaxOutput,
  exchangeRateInput,
  lineInput,
  newLineValues,
  presentLine,
  priceDocument,
  pricedLineValues,
  resolveLinks,
  taxSnapshot,
  taxesFromLines,
  today,
} from './documents.ts'
import { loadProject } from '../projects/projects.ts'
import { issueNumber } from './numbering.ts'
import { fromNumeric, percentInput, pricingRefusal } from './shared.ts'

/**
 * Quotes.
 *
 * A draft is freely edited; every edit prices the whole quote again with the
 * calculator and stores the result. Sending assigns its number, fixes its issue
 * date and exchange rate, and freezes it -- in this module and, independently,
 * in a database trigger. After that only the client's answer is recorded.
 */

type QuoteRow = typeof schema.quotes.$inferSelect
type LineRow = typeof schema.quoteLines.$inferSelect

/** How long a new quote stays open unless told otherwise. */
const DEFAULT_VALID_DAYS = 30

export const quoteLineOutput = documentLineOutput
export const quoteSummaryOutput = z.object({
  id: z.uuid(),
  /** Assigned when sent. Null for drafts. */
  number: z.string().nullable(),
  status: z.enum(schema.QUOTE_STATUSES),
  title: z.string(),
  companyId: z.uuid(),
  companyName: z.string(),
  contactId: z.uuid().nullable(),
  contactName: z.string().nullable(),
  dealId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  currency: z.string().length(3),
  taxMode: z.enum(schema.TAX_MODES),
  issueDate: z.iso.date().nullable(),
  validUntil: z.iso.date(),
  /** A percentage off the subtotal, or a fixed amount off it; at most one is set. */
  discountPercent: z.string().nullable(),
  discountAmountMinor: z.number().int().nullable(),
  subtotalMinor: z.number().int(),
  discountMinor: z.number().int(),
  taxMinor: z.number().int(),
  totalMinor: z.number().int(),
  /** Captured when sent: the base currency then, the rate into it, and the total converted. */
  baseCurrency: z.string().length(3).nullable(),
  exchangeRateToBase: z.string().nullable(),
  totalBaseMinor: z.number().int().nullable(),
  sentAt: z.date().nullable(),
  acceptedAt: z.date().nullable(),
  declinedAt: z.date().nullable(),
  declineReason: z.string().nullable(),
  expiredAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const quoteOutput = quoteSummaryOutput.extend({
  notes: z.string().nullable(),
  terms: z.string().nullable(),
  lines: z.array(quoteLineOutput),
  /** One entry per tax, in order of first use. `amountMinor` is what it is charged on. */
  taxes: z.array(documentTaxOutput),
})

export type Quote = z.infer<typeof quoteOutput>
export type QuoteSummary = z.infer<typeof quoteSummaryOutput>

const quoteContact = alias(schema.contacts, 'quote_contact')

function selectQuotes(ctx: ActorContext) {
  return ctx.tx
    .select({
      quote: schema.quotes,
      companyName: schema.companies.name,
      contactName: sql<string | null>`nullif(trim(concat_ws(' ', ${quoteContact.firstName}, ${quoteContact.lastName})), '')`,
    })
    .from(schema.quotes)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.quotes.companyId))
    .leftJoin(quoteContact, eq(quoteContact.id, schema.quotes.contactId))
}

function presentSummary(row: { quote: QuoteRow; companyName: string; contactName: string | null }): QuoteSummary {
  const q = row.quote
  return {
    id: q.id,
    number: q.number,
    status: q.status as QuoteSummary['status'],
    title: q.title,
    companyId: q.companyId,
    companyName: row.companyName,
    contactId: q.contactId,
    contactName: row.contactName,
    dealId: q.dealId,
    projectId: q.projectId,
    currency: q.currency,
    taxMode: q.taxMode as QuoteSummary['taxMode'],
    issueDate: q.issueDate,
    validUntil: q.validUntil,
    discountPercent: fromNumeric(q.discountPercent),
    discountAmountMinor: q.discountAmountMinor,
    subtotalMinor: q.subtotalMinor,
    discountMinor: q.discountMinor,
    taxMinor: q.taxMinor,
    totalMinor: q.totalMinor,
    baseCurrency: q.baseCurrency,
    exchangeRateToBase: q.exchangeRateToBase === null ? null : formatDecimal(parseDecimal(q.exchangeRateToBase, RATE_SCALE), RATE_SCALE),
    totalBaseMinor: q.totalBaseMinor,
    sentAt: q.sentAt,
    acceptedAt: q.acceptedAt,
    declinedAt: q.declinedAt,
    declineReason: q.declineReason,
    expiredAt: q.expiredAt,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  }
}

async function loadLines(ctx: ActorContext, quoteId: string): Promise<LineRow[]> {
  const l = schema.quoteLines
  return ctx.tx.select().from(l).where(eq(l.quoteId, quoteId)).orderBy(asc(l.position), asc(l.id))
}

export async function getQuote(ctx: ActorContext, id: string): Promise<Quote> {
  const [row] = await selectQuotes(ctx).where(eq(schema.quotes.id, id)).limit(1)
  if (!row) throw new NotFoundError('Quote', id)
  const lines = (await loadLines(ctx, id)).map(presentLine)
  return { ...presentSummary(row), notes: row.quote.notes, terms: row.quote.terms, lines, taxes: taxesFromLines(lines) }
}

export async function loadQuote(ctx: ActorContext, id: string, options: { lock?: boolean } = {}): Promise<QuoteRow> {
  const query = ctx.tx.select().from(schema.quotes).where(eq(schema.quotes.id, id)).limit(1)
  const [row] = options.lock ? await query.for('update') : await query
  if (!row) throw new NotFoundError('Quote', id)
  return row
}

function requireDraft(quote: QuoteRow): void {
  if (quote.status !== 'draft') {
    throw new DomainError(`This quote has been ${quote.status === 'sent' ? 'sent' : quote.status}, so it can no longer be changed. Duplicate it to revise it.`, 'quote_not_draft')
  }
}

/**
 * Prices the quote from its stored lines and stores the result. Every change to
 * a draft ends here, so stored totals are always the calculator's.
 */
async function recalculate(ctx: ActorContext, quoteId: string): Promise<void> {
  const quote = await loadQuote(ctx, quoteId)
  const lines = await loadLines(ctx, quoteId)
  const result = priceDocument(quote, lines)
  for (const [i, line] of lines.entries()) {
    await ctx.tx.update(schema.quoteLines).set(pricedLineValues(result.lines[i]!)).where(eq(schema.quoteLines.id, line.id))
  }
  await ctx.tx
    .update(schema.quotes)
    .set({ subtotalMinor: result.subtotalMinor, discountMinor: result.discountMinor, taxMinor: result.taxMinor, totalMinor: result.totalMinor, updatedAt: ctx.now })
    .where(eq(schema.quotes.id, quoteId))
}

async function nextPosition(ctx: ActorContext, quoteId: string): Promise<number> {
  const [row] = await ctx.tx.select({ last: max(schema.quoteLines.position) }).from(schema.quoteLines).where(eq(schema.quoteLines.quoteId, quoteId))
  return (row?.last ?? 0) + 1
}

// Reads

export const quoteList = defineProcedure({
  name: 'quote.list',
  summary: 'Quotes, newest first, filtered by status, client, deal, or project',
  permission: 'quote:read',
  readOnly: true,
  input: z.object({
    status: z.enum(schema.QUOTE_STATUSES).optional(),
    companyId: z.uuid().optional(),
    dealId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    /** Matches the title or number. */
    q: searchInput,
    ...pageInput,
  }),
  output: pageOutput(quoteSummaryOutput),
  http: { method: 'GET', path: '/quotes' },
  async handler(ctx, input) {
    const q = schema.quotes
    // Filters name records too: another organization's company is "not found", not an empty list.
    if (input.companyId) await loadCompany(ctx, input.companyId)
    if (input.dealId) await loadDeal(ctx, input.dealId)
    if (input.projectId) await loadProject(ctx, input.projectId)
    const conditions: Array<SQL | undefined> = [
      input.status ? eq(q.status, input.status) : undefined,
      input.companyId ? eq(q.companyId, input.companyId) : undefined,
      input.dealId ? eq(q.dealId, input.dealId) : undefined,
      input.projectId ? eq(q.projectId, input.projectId) : undefined,
      input.q ? or(ilike(q.title, contains(input.q)), ilike(q.number, contains(input.q))) : undefined,
      input.cursor ? lt(q.id, input.cursor) : undefined,
    ]
    const rows = await selectQuotes(ctx).where(and(...conditions)).orderBy(desc(q.id)).limit(input.limit + 1)
    return paginate(rows.map(presentSummary), input.limit)
  },
})

export const quoteGet = defineProcedure({
  name: 'quote.get',
  summary: 'One quote, with its lines and taxes',
  permission: 'quote:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: quoteOutput,
  http: { method: 'GET', path: '/quotes/{id}' },
  async handler(ctx, input) {
    return getQuote(ctx, input.id)
  },
})

// Drafts

const header = {
  contactId: z.uuid().nullish(),
  projectId: z.uuid().nullish(),
  taxMode: z.enum(schema.TAX_MODES).optional(),
  validUntil: z.iso.date().optional(),
  discountPercent: percentInput.nullish(),
  discountAmountMinor: minorAmount.nullish(),
  notes: optionalText(10_000),
  terms: optionalText(10_000),
}

export const quoteCreate = defineProcedure({
  name: 'quote.create',
  summary: 'Start a draft quote, optionally with its lines',
  permission: 'quote:create',
  input: z.object({
    title: requiredText(200, 'Title'),
    /** The client. Implied by `dealId` when omitted. */
    companyId: z.uuid().nullish(),
    dealId: z.uuid().nullish(),
    ...header,
    /** Defaults to the deal's currency, or the organization's base currency. */
    currency: currencyCode.optional(),
    lines: z.array(lineInput).max(500).default([]),
  }),
  output: quoteOutput,
  http: { method: 'POST', path: '/quotes', successStatus: 201 },
  emits: ['quote.created'],
  async handler(ctx, input) {
    const { company, deal } = await resolveLinks(ctx, input)
    refuseArchived(company, 'company')
    assertOneDiscount(input.discountPercent, input.discountAmountMinor)

    const id = newId()
    await ctx.tx.insert(schema.quotes).values({
      id,
      organizationId: ctx.organizationId,
      companyId: company.id,
      contactId: input.contactId ?? null,
      dealId: deal?.id ?? null,
      projectId: input.projectId ?? null,
      title: input.title,
      currency: input.currency ?? deal?.currency ?? (await baseCurrency(ctx)),
      taxMode: input.taxMode ?? 'exclusive',
      validUntil: input.validUntil ?? addDays(await today(ctx), DEFAULT_VALID_DAYS),
      discountPercent: input.discountPercent ?? null,
      discountAmountMinor: input.discountAmountMinor ?? null,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      createdBy: actingUserId(ctx),
    })
    const quote = await loadQuote(ctx, id)
    for (const [i, line] of input.lines.entries()) {
      await ctx.tx.insert(schema.quoteLines).values({
        id: newId(),
        organizationId: ctx.organizationId,
        quoteId: quote.id,
        position: i + 1,
        ...(await newLineValues(ctx, quote, line, `lines.${i}.`)),
      })
    }
    await recalculate(ctx, id)

    const created = await getQuote(ctx, id)
    await ctx.audit({ action: 'quote.created', entityType: 'quote', entityId: id, entityLabel: created.title })
    await ctx.emit('quote.created', created)
    return created
  },
})

export const quoteUpdate = defineProcedure({
  name: 'quote.update',
  summary: "Change a draft quote's details or discount. Sent quotes cannot change.",
  permission: 'quote:update',
  input: z.object({
    id: z.uuid(),
    title: requiredText(200, 'Title').optional(),
    companyId: z.uuid().optional(),
    dealId: z.uuid().nullish(),
    ...header,
    /** Only while the quote has no lines: prices are in the currency they were entered in. */
    currency: currencyCode.optional(),
  }),
  output: quoteOutput,
  http: { method: 'PATCH', path: '/quotes/{id}' },
  emits: ['quote.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadQuote(ctx, id, { lock: true })
    requireDraft(before)
    const patch = provided(fields)
    assertOneDiscount(patch.discountPercent, patch.discountAmountMinor)
    // Setting one kind of discount replaces the other.
    if (patch.discountPercent != null) patch.discountAmountMinor = null
    if (patch.discountAmountMinor != null) patch.discountPercent = null

    const links = {
      companyId: patch.companyId ?? before.companyId,
      contactId: patch.contactId !== undefined ? patch.contactId : before.contactId,
      dealId: patch.dealId !== undefined ? patch.dealId : before.dealId,
      projectId: patch.projectId !== undefined ? patch.projectId : before.projectId,
    }
    const { company } = await resolveLinks(ctx, links)
    if (company.id !== before.companyId) refuseArchived(company, 'company')

    if (patch.currency && patch.currency !== before.currency && (await loadLines(ctx, id)).length > 0) {
      throw new DomainError("Remove the lines before changing the currency: their prices were entered in " + before.currency + '.', 'currency_locked', 'currency')
    }

    const comparable = { ...before, discountPercent: fromNumeric(before.discountPercent) }
    const changes = diff(comparable as Record<string, unknown>, patch)
    if (!changes) return getQuote(ctx, id)

    await ctx.tx.update(schema.quotes).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.quotes.id, id))
    await recalculate(ctx, id)
    const quote = await getQuote(ctx, id)
    await ctx.audit({ action: 'quote.updated', entityType: 'quote', entityId: id, entityLabel: quote.title, changes })
    await ctx.emit('quote.updated', quote)
    return quote
  },
})

export const quoteDelete = defineProcedure({
  name: 'quote.delete',
  summary: 'Delete a draft quote. A sent quote is a record of an offer and is never deleted.',
  permission: 'quote:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/quotes/{id}' },
  emits: ['quote.deleted'],
  async handler(ctx, input) {
    const before = await loadQuote(ctx, input.id, { lock: true })
    if (before.status !== 'draft') {
      throw new ConflictError(`Quote ${before.number} has been sent and is kept as a record. Decline it, or let it expire, instead.`)
    }
    const quote = await getQuote(ctx, before.id)
    await ctx.tx.delete(schema.quotes).where(eq(schema.quotes.id, before.id))
    await ctx.audit({ action: 'quote.deleted', entityType: 'quote', entityId: before.id, entityLabel: before.title })
    await ctx.emit('quote.deleted', quote)
    return { deleted: true }
  },
})

// Lines

export const quoteLineAdd = defineProcedure({
  name: 'quoteLine.add',
  summary: 'Add a line to a draft quote',
  permission: 'quote:update',
  input: lineInput.extend({ id: z.uuid() }),
  output: quoteOutput,
  http: { method: 'POST', path: '/quotes/{id}/lines', successStatus: 201 },
  emits: ['quote.updated'],
  async handler(ctx, input) {
    const { id, ...line } = input
    const quote = await loadQuote(ctx, id, { lock: true })
    requireDraft(quote)
    const values = { id: newId(), organizationId: ctx.organizationId, quoteId: id, position: await nextPosition(ctx, id), ...(await newLineValues(ctx, quote, line)) }
    await ctx.tx.insert(schema.quoteLines).values(values)
    await recalculate(ctx, id)
    const updated = await getQuote(ctx, id)
    await ctx.audit({ action: 'quote.updated', entityType: 'quote', entityId: id, entityLabel: updated.title, changes: { lines: { from: null, to: values.description } } })
    await ctx.emit('quote.updated', updated)
    return updated
  },
})

async function loadLineForChange(ctx: ActorContext, lineId: string) {
  const [line] = await ctx.tx.select().from(schema.quoteLines).where(eq(schema.quoteLines.id, lineId)).limit(1)
  if (!line) throw new NotFoundError('Quote line', lineId)
  const quote = await loadQuote(ctx, line.quoteId, { lock: true })
  requireDraft(quote)
  return { line, quote }
}

export const quoteLineUpdate = defineProcedure({
  name: 'quoteLine.update',
  summary: 'Change a line on a draft quote',
  permission: 'quote:update',
  input: lineInput.omit({ serviceId: true }).extend({ id: z.uuid(), description: requiredText(2000, 'Description').optional(), position: z.number().int().min(1).max(10_000).optional() }),
  output: quoteOutput,
  http: { method: 'PATCH', path: '/quote-lines/{id}' },
  emits: ['quote.updated'],
  async handler(ctx, input) {
    const { id, taxRateId, ...fields } = input
    const { line, quote } = await loadLineForChange(ctx, id)
    const patch: Partial<LineRow> = provided(fields) as Partial<LineRow>
    if (taxRateId !== undefined && taxRateId !== line.taxRateId) Object.assign(patch, await taxSnapshot(ctx, taxRateId))
    const comparable = { ...line, quantity: fromNumeric(line.quantity), discountPercent: fromNumeric(line.discountPercent) }
    const changes = diff(comparable as Record<string, unknown>, patch)
    if (!changes) return getQuote(ctx, quote.id)

    await ctx.tx.update(schema.quoteLines).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.quoteLines.id, id))
    await recalculate(ctx, quote.id)
    const updated = await getQuote(ctx, quote.id)
    await ctx.audit({ action: 'quote.updated', entityType: 'quote', entityId: quote.id, entityLabel: updated.title, changes })
    await ctx.emit('quote.updated', updated)
    return updated
  },
})

export const quoteLineRemove = defineProcedure({
  name: 'quoteLine.remove',
  summary: 'Remove a line from a draft quote',
  permission: 'quote:update',
  input: z.object({ id: z.uuid() }),
  output: quoteOutput,
  http: { method: 'DELETE', path: '/quote-lines/{id}' },
  emits: ['quote.updated'],
  async handler(ctx, input) {
    const { line, quote } = await loadLineForChange(ctx, input.id)
    await ctx.tx.delete(schema.quoteLines).where(eq(schema.quoteLines.id, line.id))
    await recalculate(ctx, quote.id)
    const updated = await getQuote(ctx, quote.id)
    await ctx.audit({ action: 'quote.updated', entityType: 'quote', entityId: quote.id, entityLabel: updated.title, changes: { lines: { from: line.description, to: null } } })
    await ctx.emit('quote.updated', updated)
    return updated
  },
})

// Sending, and the client's answer

export const quoteSend = defineProcedure({
  name: 'quote.send',
  summary: 'Mark a draft quote as sent: it takes its number, issue date, and exchange rate, and can no longer change',
  permission: 'quote:send',
  input: z.object({
    id: z.uuid(),
    /** Defaults to today in the organization's time zone. */
    issueDate: z.iso.date().optional(),
    /**
     * How many units of the organization's base currency one unit of the quote's
     * currency is worth. Required when they differ; ignored when they are the same.
     */
    exchangeRate: exchangeRateInput.optional(),
  }),
  output: quoteOutput,
  http: { method: 'POST', path: '/quotes/{id}/send' },
  emits: ['quote.sent'],
  async handler(ctx, input) {
    const quote = await loadQuote(ctx, input.id, { lock: true })
    requireDraft(quote)
    if ((await loadLines(ctx, quote.id)).length === 0) throw new DomainError('Add at least one line before sending.', 'no_lines')
    const issueDate = input.issueDate ?? (await today(ctx))
    if (quote.validUntil < issueDate) {
      throw new DomainError('The quote would already have expired. Move its valid-until date first.', 'valid_until_passed', 'validUntil')
    }
    refuseArchived(await loadCompany(ctx, quote.companyId), 'company')

    const base = await baseCurrency(ctx)
    const rate = quote.currency === base ? '1' : input.exchangeRate
    if (!rate) {
      throw new DomainError(`Enter the exchange rate from ${quote.currency} to ${base}. It is fixed on the quote when it is sent.`, 'exchange_rate_required', 'exchangeRate')
    }

    await recalculate(ctx, quote.id)
    const priced = await loadQuote(ctx, quote.id)
    let totalBaseMinor: number
    try {
      totalBaseMinor = toSafeNumber(convert(BigInt(priced.totalMinor), priced.currency, base, rate))
    } catch (error) {
      pricingRefusal(error)
    }

    await ctx.tx
      .update(schema.quotes)
      .set({
        status: 'sent',
        number: await issueNumber(ctx, 'quote'),
        issueDate,
        sentAt: ctx.now,
        baseCurrency: base,
        exchangeRateToBase: rate,
        totalBaseMinor,
        updatedAt: ctx.now,
      })
      .where(eq(schema.quotes.id, quote.id))

    const sent = await getQuote(ctx, quote.id)
    await ctx.audit({
      action: 'quote.sent',
      entityType: 'quote',
      entityId: quote.id,
      entityLabel: `${sent.number} ${sent.title}`,
      changes: { status: { from: 'draft', to: 'sent' }, number: { from: null, to: sent.number } },
    })
    await ctx.emit('quote.sent', sent)
    return sent
  },
})

async function requireOpen(ctx: ActorContext, quote: QuoteRow): Promise<void> {
  if (quote.status !== 'sent') {
    throw new DomainError(
      quote.status === 'draft' ? 'Send the quote before recording an answer.' : `This quote is already ${quote.status}.`,
      'quote_not_sent',
    )
  }
  if (quote.validUntil < (await today(ctx))) {
    throw new DomainError(`This quote expired on ${quote.validUntil}. Duplicate it to offer again.`, 'quote_expired')
  }
}

export const quoteAccept = defineProcedure({
  name: 'quote.accept',
  summary: 'Record that the client accepted a sent quote',
  permission: 'quote:update',
  input: z.object({ id: z.uuid() }),
  output: quoteOutput,
  http: { method: 'POST', path: '/quotes/{id}/accept' },
  emits: ['quote.accepted'],
  async handler(ctx, input) {
    const quote = await loadQuote(ctx, input.id, { lock: true })
    await requireOpen(ctx, quote)
    await ctx.tx.update(schema.quotes).set({ status: 'accepted', acceptedAt: ctx.now, updatedAt: ctx.now }).where(eq(schema.quotes.id, quote.id))
    const accepted = await getQuote(ctx, quote.id)
    await ctx.audit({ action: 'quote.accepted', entityType: 'quote', entityId: quote.id, entityLabel: `${quote.number} ${quote.title}`, changes: { status: { from: 'sent', to: 'accepted' } } })
    await ctx.emit('quote.accepted', accepted)
    return accepted
  },
})

export const quoteDecline = defineProcedure({
  name: 'quote.decline',
  summary: 'Record that the client declined a sent quote',
  permission: 'quote:update',
  input: z.object({ id: z.uuid(), reason: optionalText(2000) }),
  output: quoteOutput,
  http: { method: 'POST', path: '/quotes/{id}/decline' },
  emits: ['quote.declined'],
  async handler(ctx, input) {
    const quote = await loadQuote(ctx, input.id, { lock: true })
    await requireOpen(ctx, quote)
    await ctx.tx
      .update(schema.quotes)
      .set({ status: 'declined', declinedAt: ctx.now, declineReason: input.reason ?? null, updatedAt: ctx.now })
      .where(eq(schema.quotes.id, quote.id))
    const declined = await getQuote(ctx, quote.id)
    await ctx.audit({ action: 'quote.declined', entityType: 'quote', entityId: quote.id, entityLabel: `${quote.number} ${quote.title}`, changes: { status: { from: 'sent', to: 'declined' } } })
    await ctx.emit('quote.declined', declined)
    return declined
  },
})

export const quoteDuplicate = defineProcedure({
  name: 'quote.duplicate',
  summary: 'Copy any quote into a new draft, to revise or offer again',
  permission: 'quote:create',
  input: z.object({ id: z.uuid() }),
  output: quoteOutput,
  http: { method: 'POST', path: '/quotes/{id}/duplicate', successStatus: 201 },
  emits: ['quote.created'],
  async handler(ctx, input) {
    const source = await loadQuote(ctx, input.id)
    refuseArchived(await loadCompany(ctx, source.companyId), 'company')
    const id = newId()
    await ctx.tx.insert(schema.quotes).values({
      id,
      organizationId: ctx.organizationId,
      companyId: source.companyId,
      contactId: source.contactId,
      dealId: source.dealId,
      projectId: source.projectId,
      title: source.title,
      currency: source.currency,
      taxMode: source.taxMode,
      validUntil: addDays(await today(ctx), DEFAULT_VALID_DAYS),
      discountPercent: source.discountPercent,
      discountAmountMinor: source.discountAmountMinor,
      notes: source.notes,
      terms: source.terms,
      createdBy: actingUserId(ctx),
    })
    for (const line of await loadLines(ctx, source.id)) {
      await ctx.tx.insert(schema.quoteLines).values({ ...line, id: newId(), quoteId: id, createdAt: ctx.now, updatedAt: ctx.now })
    }
    await recalculate(ctx, id)
    const copy = await getQuote(ctx, id)
    await ctx.audit({ action: 'quote.created', entityType: 'quote', entityId: id, entityLabel: copy.title, changes: { duplicatedFrom: { from: null, to: source.number ?? source.id } } })
    await ctx.emit('quote.created', copy)
    return copy
  },
})

/**
 * Marks sent quotes past their valid-until date as expired, in one organization.
 * Run by the worker for each organization, as a job actor; returns how many expired.
 */
export async function expireDueQuotes(ctx: ActorContext): Promise<number> {
  const q = schema.quotes
  const due = await ctx.tx
    .select({ id: q.id })
    .from(q)
    .where(and(eq(q.status, 'sent'), lt(q.validUntil, await today(ctx))))
    .for('update', { skipLocked: true })
  for (const { id } of due) {
    await ctx.tx.update(q).set({ status: 'expired', expiredAt: ctx.now, updatedAt: ctx.now }).where(eq(q.id, id))
    const expired = await getQuote(ctx, id)
    await ctx.audit({ action: 'quote.expired', entityType: 'quote', entityId: id, entityLabel: `${expired.number} ${expired.title}`, changes: { status: { from: 'sent', to: 'expired' } } })
    await ctx.emit('quote.expired', expired)
  }
  return due.length
}
