import { env } from '@workloom/config'
import { alias, and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lt, max, or, schema, sql, withTenant, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { ConflictError, DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { readLinkToken, signLinkToken } from '../../crypto.ts'
import { newId } from '../../ids.ts'
import { convert, formatDecimal, parseDecimal, RATE_SCALE, toSafeNumber } from '../../money/money.ts'
import { buildContext, defineProcedure } from '../../registry/index.ts'
import { addDays, secondsToHours } from '../../time/index.ts'
import { loadCompany } from '../crm/companies.ts'
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
import { loadProject } from '../projects/projects.ts'
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
  UNPRICED,
} from './documents.ts'
import { rebillAmount, releaseExpenses, unbilledExpenses } from './expenses.ts'
import { issueNumber } from './numbering.ts'
import { loadQuote } from './quotes.ts'
import { fromNumeric, percentInput } from './shared.ts'

/**
 * Invoices.
 *
 * A draft is edited and priced exactly like a quote, through
 * `documents.ts`. Issuing one gives it its number, its issue and due dates, and
 * its exchange rate, and freezes it -- here and, independently, in a database
 * trigger. What follows is only what happens *to* an issued invoice: the client
 * opening it, a cancellation, and the payments against it -- which live in
 * `payments.ts`, since it is the allocations that decide what it is settled by.
 */

type InvoiceRow = typeof schema.invoices.$inferSelect
type LineRow = typeof schema.invoiceLines.$inferSelect

/** The purpose the client's link is signed for. */
const LINK_PURPOSE = 'document-link'

/** A link a client can open without an account. It names its own tenant and document. */
export function documentLink(kind: 'invoice', organizationId: string, documentId: string): string {
  return `${env.APP_URL.replace(/\/$/, '')}/i/${signLinkToken(LINK_PURPOSE, `${kind}:${organizationId}:${documentId}`)}`
}

/** What a client's link points at, or null if it was not signed for this. */
export function readDocumentToken(token: string): { kind: 'invoice'; organizationId: string; documentId: string } | null {
  const payload = readLinkToken(LINK_PURPOSE, token)
  if (!payload) return null
  const [kind, organizationId, documentId] = payload.split(':')
  if (kind !== 'invoice' || !organizationId || !documentId) return null
  return { kind, organizationId, documentId }
}

/** How long a link to a rendered PDF stays good for whoever asked for it. */
const PDF_LINK_SECONDS = 10 * 60
const PDF_PURPOSE = 'document-pdf'

/**
 * A short-lived link to the rendered PDF, for a caller who has just proved they
 * may read the invoice. The same shape as a stored file's download link (S5):
 * the permission check happens when the link is issued, and the link itself
 * carries only what it opens and when it stops working.
 */
export function invoicePdfLink(organizationId: string, invoiceId: string, expiresAt: Date): string {
  const token = signLinkToken(PDF_PURPOSE, `invoice:${organizationId}:${invoiceId}:${expiresAt.getTime()}`)
  return `${env.APP_URL.replace(/\/$/, '')}/api/documents/${token}`
}

/** What a PDF link opens, or null if it was altered or has expired. */
export function readPdfToken(token: string, now = new Date()): { organizationId: string; documentId: string } | null {
  const payload = readLinkToken(PDF_PURPOSE, token)
  if (!payload) return null
  const [kind, organizationId, documentId, expiresAt] = payload.split(':')
  if (kind !== 'invoice' || !organizationId || !documentId || !expiresAt) return null
  if (Number(expiresAt) < now.getTime()) return null
  return { organizationId, documentId }
}

export const invoiceLineOutput = documentLineOutput

export const invoiceSummaryOutput = z.object({
  id: z.uuid(),
  /** Assigned when the invoice is issued. Null for drafts. */
  number: z.string().nullable(),
  status: z.enum(schema.INVOICE_STATUSES),
  title: z.string(),
  companyId: z.uuid(),
  companyName: z.string(),
  contactId: z.uuid().nullable(),
  contactName: z.string().nullable(),
  dealId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  quoteId: z.uuid().nullable(),
  currency: z.string().length(3),
  taxMode: z.enum(schema.TAX_MODES),
  issueDate: z.iso.date().nullable(),
  dueDate: z.iso.date().nullable(),
  paymentTermsDays: z.number().int(),
  discountPercent: z.string().nullable(),
  discountAmountMinor: z.number().int().nullable(),
  subtotalMinor: z.number().int(),
  discountMinor: z.number().int(),
  taxMinor: z.number().int(),
  totalMinor: z.number().int(),
  /** Payments less refunds allocated to it, maintained by the database from those allocations. */
  amountPaidMinor: z.number().int(),
  /** Total less what has been paid. */
  amountDueMinor: z.number().int(),
  baseCurrency: z.string().length(3).nullable(),
  exchangeRateToBase: z.string().nullable(),
  totalBaseMinor: z.number().int().nullable(),
  sentAt: z.date().nullable(),
  emailTo: z.string().nullable(),
  emailSentAt: z.date().nullable(),
  viewedAt: z.date().nullable(),
  paidAt: z.date().nullable(),
  cancelledAt: z.date().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const invoiceOutput = invoiceSummaryOutput.extend({
  notes: z.string().nullable(),
  terms: z.string().nullable(),
  lines: z.array(invoiceLineOutput),
  taxes: z.array(documentTaxOutput),
  /** The link a client opens to see and pay it. Null while the invoice is a draft. */
  publicUrl: z.url().nullable(),
})

export type Invoice = z.infer<typeof invoiceOutput>
export type InvoiceSummary = z.infer<typeof invoiceSummaryOutput>

const invoiceContact = alias(schema.contacts, 'invoice_contact')

function selectInvoices(ctx: ActorContext) {
  return ctx.tx
    .select({
      invoice: schema.invoices,
      companyName: schema.companies.name,
      contactName: sql<string | null>`nullif(trim(concat_ws(' ', ${invoiceContact.firstName}, ${invoiceContact.lastName})), '')`,
    })
    .from(schema.invoices)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.invoices.companyId))
    .leftJoin(invoiceContact, eq(invoiceContact.id, schema.invoices.contactId))
}

function presentSummary(row: { invoice: InvoiceRow; companyName: string; contactName: string | null }): InvoiceSummary {
  const i = row.invoice
  return {
    id: i.id,
    number: i.number,
    status: i.status as InvoiceSummary['status'],
    title: i.title,
    companyId: i.companyId,
    companyName: row.companyName,
    contactId: i.contactId,
    contactName: row.contactName,
    dealId: i.dealId,
    projectId: i.projectId,
    quoteId: i.quoteId,
    currency: i.currency,
    taxMode: i.taxMode as InvoiceSummary['taxMode'],
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    paymentTermsDays: i.paymentTermsDays,
    discountPercent: fromNumeric(i.discountPercent),
    discountAmountMinor: i.discountAmountMinor,
    subtotalMinor: i.subtotalMinor,
    discountMinor: i.discountMinor,
    taxMinor: i.taxMinor,
    totalMinor: i.totalMinor,
    amountPaidMinor: i.amountPaidMinor,
    amountDueMinor: i.totalMinor - i.amountPaidMinor,
    baseCurrency: i.baseCurrency,
    exchangeRateToBase: i.exchangeRateToBase === null ? null : formatDecimal(parseDecimal(i.exchangeRateToBase, RATE_SCALE), RATE_SCALE),
    totalBaseMinor: i.totalBaseMinor,
    sentAt: i.sentAt,
    emailTo: i.emailTo,
    emailSentAt: i.emailSentAt,
    viewedAt: i.viewedAt,
    paidAt: i.paidAt,
    cancelledAt: i.cancelledAt,
    cancelReason: i.cancelReason,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  }
}

async function loadLines(ctx: ActorContext, invoiceId: string): Promise<LineRow[]> {
  const l = schema.invoiceLines
  return ctx.tx.select().from(l).where(eq(l.invoiceId, invoiceId)).orderBy(asc(l.position), asc(l.id))
}

export async function getInvoice(ctx: ActorContext, id: string): Promise<Invoice> {
  const [row] = await selectInvoices(ctx).where(eq(schema.invoices.id, id)).limit(1)
  if (!row) throw new NotFoundError('Invoice', id)
  const lines = (await loadLines(ctx, id)).map(presentLine)
  return {
    ...presentSummary(row),
    notes: row.invoice.notes,
    terms: row.invoice.terms,
    lines,
    taxes: taxesFromLines(lines),
    publicUrl: row.invoice.status === 'draft' ? null : documentLink('invoice', ctx.organizationId, id),
  }
}

export async function loadInvoice(ctx: ActorContext, id: string, options: { lock?: boolean } = {}): Promise<InvoiceRow> {
  const query = ctx.tx.select().from(schema.invoices).where(eq(schema.invoices.id, id)).limit(1)
  const [row] = options.lock ? await query.for('update') : await query
  if (!row) throw new NotFoundError('Invoice', id)
  return row
}

function requireDraft(invoice: InvoiceRow): void {
  if (invoice.status !== 'draft') {
    throw new DomainError(
      `Invoice ${invoice.number} has been issued, so it can no longer be changed. Cancel it and raise another if it is wrong.`,
      'invoice_not_draft',
    )
  }
}

async function recalculate(ctx: ActorContext, invoiceId: string): Promise<void> {
  const invoice = await loadInvoice(ctx, invoiceId)
  const lines = await loadLines(ctx, invoiceId)
  const result = priceDocument(invoice, lines)
  for (const [i, line] of lines.entries()) {
    await ctx.tx.update(schema.invoiceLines).set(pricedLineValues(result.lines[i]!)).where(eq(schema.invoiceLines.id, line.id))
  }
  await ctx.tx
    .update(schema.invoices)
    .set({ subtotalMinor: result.subtotalMinor, discountMinor: result.discountMinor, taxMinor: result.taxMinor, totalMinor: result.totalMinor, updatedAt: ctx.now })
    .where(eq(schema.invoices.id, invoiceId))
}

async function nextPosition(ctx: ActorContext, invoiceId: string): Promise<number> {
  const [row] = await ctx.tx.select({ last: max(schema.invoiceLines.position) }).from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId))
  return (row?.last ?? 0) + 1
}

/** The organization's default payment terms, for a new invoice. */
async function defaultTerms(ctx: ActorContext): Promise<number> {
  const [org] = await ctx.tx
    .select({ days: schema.organization.paymentTermsDays })
    .from(schema.organization)
    .where(eq(schema.organization.id, ctx.organizationId))
    .limit(1)
  return org?.days ?? 14
}

// Reads

export const invoiceList = defineProcedure({
  name: 'invoice.list',
  summary: 'Invoices, newest first, filtered by status, client, project, or quote',
  permission: 'invoice:read',
  readOnly: true,
  input: z.object({
    status: z.enum(schema.INVOICE_STATUSES).optional(),
    companyId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    quoteId: z.uuid().optional(),
    /** Only invoices with something still to pay. */
    outstanding: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).optional(),
    /** Matches the title or number. */
    q: searchInput,
    ...pageInput,
  }),
  output: pageOutput(invoiceSummaryOutput),
  http: { method: 'GET', path: '/invoices' },
  async handler(ctx, input) {
    const i = schema.invoices
    if (input.companyId) await loadCompany(ctx, input.companyId)
    if (input.projectId) await loadProject(ctx, input.projectId)
    if (input.quoteId) await loadQuote(ctx, input.quoteId)
    const conditions: Array<SQL | undefined> = [
      input.status ? eq(i.status, input.status) : undefined,
      input.companyId ? eq(i.companyId, input.companyId) : undefined,
      input.projectId ? eq(i.projectId, input.projectId) : undefined,
      input.quoteId ? eq(i.quoteId, input.quoteId) : undefined,
      input.outstanding === undefined
        ? undefined
        : input.outstanding
          ? sql`${i.status} not in ('draft', 'paid', 'cancelled', 'refunded') and ${i.totalMinor} > ${i.amountPaidMinor}`
          : sql`${i.status} in ('paid', 'cancelled', 'refunded') or ${i.totalMinor} <= ${i.amountPaidMinor}`,
      input.q ? or(ilike(i.title, contains(input.q)), ilike(i.number, contains(input.q))) : undefined,
      input.cursor ? lt(i.id, input.cursor) : undefined,
    ]
    const rows = await selectInvoices(ctx).where(and(...conditions)).orderBy(desc(i.id)).limit(input.limit + 1)
    return paginate(rows.map(presentSummary), input.limit)
  },
})

export const invoiceGet = defineProcedure({
  name: 'invoice.get',
  summary: 'One invoice, with its lines and taxes',
  permission: 'invoice:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: invoiceOutput,
  http: { method: 'GET', path: '/invoices/{id}' },
  async handler(ctx, input) {
    return getInvoice(ctx, input.id)
  },
})

// Drafts

const header = {
  contactId: z.uuid().nullish(),
  projectId: z.uuid().nullish(),
  taxMode: z.enum(schema.TAX_MODES).optional(),
  /** Days from issue to due. Defaults to the organization's terms. */
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  discountPercent: percentInput.nullish(),
  discountAmountMinor: minorAmount.nullish(),
  notes: optionalText(10_000),
  terms: optionalText(10_000),
}

export const invoiceCreate = defineProcedure({
  name: 'invoice.create',
  summary: 'Start a draft invoice, optionally with its lines',
  permission: 'invoice:create',
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
  output: invoiceOutput,
  http: { method: 'POST', path: '/invoices', successStatus: 201 },
  emits: ['invoice.created'],
  async handler(ctx, input) {
    const { company, deal } = await resolveLinks(ctx, input, 'invoice')
    refuseArchived(company, 'company')
    assertOneDiscount(input.discountPercent, input.discountAmountMinor)

    const id = newId()
    await ctx.tx.insert(schema.invoices).values({
      id,
      organizationId: ctx.organizationId,
      companyId: company.id,
      contactId: input.contactId ?? null,
      dealId: deal?.id ?? null,
      projectId: input.projectId ?? null,
      title: input.title,
      currency: input.currency ?? deal?.currency ?? (await baseCurrency(ctx)),
      taxMode: input.taxMode ?? 'exclusive',
      paymentTermsDays: input.paymentTermsDays ?? (await defaultTerms(ctx)),
      discountPercent: input.discountPercent ?? null,
      discountAmountMinor: input.discountAmountMinor ?? null,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      createdBy: actingUserId(ctx),
    })
    const invoice = await loadInvoice(ctx, id)
    for (const [i, line] of input.lines.entries()) {
      await ctx.tx.insert(schema.invoiceLines).values({
        id: newId(),
        organizationId: ctx.organizationId,
        invoiceId: id,
        position: i + 1,
        ...(await newLineValues(ctx, invoice, line, `lines.${i}.`)),
      })
    }
    await recalculate(ctx, id)

    const created = await getInvoice(ctx, id)
    await ctx.audit({ action: 'invoice.created', entityType: 'invoice', entityId: id, entityLabel: created.title })
    await ctx.emit('invoice.created', created)
    return created
  },
})

export const invoiceUpdate = defineProcedure({
  name: 'invoice.update',
  summary: "Change a draft invoice's details or discount. Issued invoices cannot change.",
  permission: 'invoice:update',
  input: z.object({
    id: z.uuid(),
    title: requiredText(200, 'Title').optional(),
    companyId: z.uuid().optional(),
    dealId: z.uuid().nullish(),
    ...header,
    /** Only while the invoice has no lines: prices are in the currency they were entered in. */
    currency: currencyCode.optional(),
  }),
  output: invoiceOutput,
  http: { method: 'PATCH', path: '/invoices/{id}' },
  emits: ['invoice.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadInvoice(ctx, id, { lock: true })
    requireDraft(before)
    const patch = provided(fields)
    assertOneDiscount(patch.discountPercent, patch.discountAmountMinor)
    if (patch.discountPercent != null) patch.discountAmountMinor = null
    if (patch.discountAmountMinor != null) patch.discountPercent = null

    const { company } = await resolveLinks(
      ctx,
      {
        companyId: patch.companyId ?? before.companyId,
        contactId: patch.contactId !== undefined ? patch.contactId : before.contactId,
        dealId: patch.dealId !== undefined ? patch.dealId : before.dealId,
        projectId: patch.projectId !== undefined ? patch.projectId : before.projectId,
      },
      'invoice',
    )
    if (company.id !== before.companyId) refuseArchived(company, 'company')

    if (patch.currency && patch.currency !== before.currency && (await loadLines(ctx, id)).length > 0) {
      throw new DomainError(`Remove the lines before changing the currency: their prices were entered in ${before.currency}.`, 'currency_locked', 'currency')
    }

    const changes = diff({ ...before, discountPercent: fromNumeric(before.discountPercent) } as Record<string, unknown>, patch)
    if (!changes) return getInvoice(ctx, id)

    await ctx.tx.update(schema.invoices).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.invoices.id, id))
    await recalculate(ctx, id)
    const invoice = await getInvoice(ctx, id)
    await ctx.audit({ action: 'invoice.updated', entityType: 'invoice', entityId: id, entityLabel: invoice.title, changes })
    await ctx.emit('invoice.updated', invoice)
    return invoice
  },
})

/**
 * What a line billed is released when the line goes, so it can be billed again:
 * the tracked time it charged for, and any expense it rebilled.
 */
async function releaseBilled(ctx: ActorContext, lineIds: string[]): Promise<void> {
  if (lineIds.length === 0) return
  await ctx.tx
    .update(schema.timeEntries)
    .set({ invoiceLineId: null, updatedAt: ctx.now })
    .where(inArray(schema.timeEntries.invoiceLineId, lineIds))
  await releaseExpenses(ctx, lineIds)
}

export const invoiceDelete = defineProcedure({
  name: 'invoice.delete',
  summary: 'Delete a draft invoice. An issued invoice is a demand for payment and is never deleted.',
  permission: 'invoice:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/invoices/{id}' },
  emits: ['invoice.deleted'],
  async handler(ctx, input) {
    const before = await loadInvoice(ctx, input.id, { lock: true })
    if (before.status !== 'draft') {
      throw new ConflictError(`Invoice ${before.number} has been issued and is kept as a record. Cancel it instead.`)
    }
    const invoice = await getInvoice(ctx, before.id)
    await releaseBilled(ctx, (await loadLines(ctx, before.id)).map((l) => l.id))
    await ctx.tx.delete(schema.invoices).where(eq(schema.invoices.id, before.id))
    await ctx.audit({ action: 'invoice.deleted', entityType: 'invoice', entityId: before.id, entityLabel: before.title })
    await ctx.emit('invoice.deleted', invoice)
    return { deleted: true }
  },
})

// Lines

export const invoiceLineAdd = defineProcedure({
  name: 'invoiceLine.add',
  summary: 'Add a line to a draft invoice',
  permission: 'invoice:update',
  input: lineInput.extend({ id: z.uuid() }),
  output: invoiceOutput,
  http: { method: 'POST', path: '/invoices/{id}/lines', successStatus: 201 },
  emits: ['invoice.updated'],
  async handler(ctx, input) {
    const { id, ...line } = input
    const invoice = await loadInvoice(ctx, id, { lock: true })
    requireDraft(invoice)
    const values = {
      id: newId(),
      organizationId: ctx.organizationId,
      invoiceId: id,
      position: await nextPosition(ctx, id),
      ...(await newLineValues(ctx, invoice, line)),
    }
    await ctx.tx.insert(schema.invoiceLines).values(values)
    await recalculate(ctx, id)
    const updated = await getInvoice(ctx, id)
    await ctx.audit({ action: 'invoice.updated', entityType: 'invoice', entityId: id, entityLabel: updated.title, changes: { lines: { from: null, to: values.description } } })
    await ctx.emit('invoice.updated', updated)
    return updated
  },
})

async function loadLineForChange(ctx: ActorContext, lineId: string) {
  const [line] = await ctx.tx.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.id, lineId)).limit(1)
  if (!line) throw new NotFoundError('Invoice line', lineId)
  const invoice = await loadInvoice(ctx, line.invoiceId, { lock: true })
  requireDraft(invoice)
  return { line, invoice }
}

export const invoiceLineUpdate = defineProcedure({
  name: 'invoiceLine.update',
  summary: 'Change a line on a draft invoice',
  permission: 'invoice:update',
  input: lineInput.omit({ serviceId: true }).extend({ id: z.uuid(), description: requiredText(2000, 'Description').optional() }),
  output: invoiceOutput,
  http: { method: 'PATCH', path: '/invoice-lines/{id}' },
  emits: ['invoice.updated'],
  async handler(ctx, input) {
    const { id, taxRateId, ...fields } = input
    const { line, invoice } = await loadLineForChange(ctx, id)
    const patch: Partial<LineRow> = provided(fields) as Partial<LineRow>
    if (taxRateId !== undefined && taxRateId !== line.taxRateId) Object.assign(patch, await taxSnapshot(ctx, taxRateId))

    const comparable = { ...line, quantity: fromNumeric(line.quantity), discountPercent: fromNumeric(line.discountPercent) }
    const changes = diff(comparable as Record<string, unknown>, patch)
    if (!changes) return getInvoice(ctx, invoice.id)

    await ctx.tx.update(schema.invoiceLines).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.invoiceLines.id, id))
    await recalculate(ctx, invoice.id)
    const updated = await getInvoice(ctx, invoice.id)
    await ctx.audit({ action: 'invoice.updated', entityType: 'invoice', entityId: invoice.id, entityLabel: updated.title, changes })
    await ctx.emit('invoice.updated', updated)
    return updated
  },
})

export const invoiceLineRemove = defineProcedure({
  name: 'invoiceLine.remove',
  summary: 'Remove a line from a draft invoice. What it billed becomes billable again.',
  permission: 'invoice:update',
  input: z.object({ id: z.uuid() }),
  output: invoiceOutput,
  http: { method: 'DELETE', path: '/invoice-lines/{id}' },
  emits: ['invoice.updated'],
  async handler(ctx, input) {
    const { line, invoice } = await loadLineForChange(ctx, input.id)
    await releaseBilled(ctx, [line.id])
    await ctx.tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.id, line.id))
    await recalculate(ctx, invoice.id)
    const updated = await getInvoice(ctx, invoice.id)
    await ctx.audit({ action: 'invoice.updated', entityType: 'invoice', entityId: invoice.id, entityLabel: updated.title, changes: { lines: { from: line.description, to: null } } })
    await ctx.emit('invoice.updated', updated)
    return updated
  },
})

// Billing tracked time

const billedOutput = invoiceOutput.extend({
  billed: z.object({
    linesAdded: z.number().int(),
    entriesBilled: z.number().int(),
    secondsBilled: z.number().int(),
    /** Billable time left out because no rate was resolved when it was logged. */
    entriesWithoutRate: z.number().int(),
  }),
})

export const invoiceBillTime = defineProcedure({
  name: 'invoice.billTime',
  summary: "Add the client's unbilled billable time to a draft invoice, at the rates it was logged at",
  permission: 'invoice:update',
  input: z.object({
    id: z.uuid(),
    /** One project, or every project of this client. */
    projectId: z.uuid().optional(),
    /** Inclusive calendar dates, against the day the time was spent. */
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    /** One line per task, per person, or per entry. */
    groupBy: z.enum(['task', 'person', 'entry']).default('task'),
    /** The tax to apply to the lines this adds. */
    taxRateId: z.uuid().nullish(),
  }),
  output: billedOutput,
  http: { method: 'POST', path: '/invoices/{id}/time', successStatus: 201 },
  emits: ['invoice.updated'],
  async handler(ctx, input) {
    ctx.require('timeEntry:read')
    const invoice = await loadInvoice(ctx, input.id, { lock: true })
    requireDraft(invoice)
    if (input.projectId) {
      const project = await loadProject(ctx, input.projectId)
      if (project.companyId !== invoice.companyId) throw new DomainError('That project is for a different client.', 'project_company_mismatch', 'projectId')
    }

    const t = schema.timeEntries
    const entries = await ctx.tx
      .select({
        entry: t,
        projectName: schema.projects.name,
        taskTitle: schema.tasks.title,
        personName: schema.user.name,
      })
      .from(t)
      .innerJoin(schema.projects, eq(schema.projects.id, t.projectId))
      .leftJoin(schema.tasks, eq(schema.tasks.id, t.taskId))
      .innerJoin(schema.user, eq(schema.user.id, t.userId))
      .where(
        and(
          eq(t.billable, true),
          isNull(t.invoiceLineId),
          isNotNull(t.durationSeconds),
          eq(t.currency, invoice.currency),
          input.projectId ? eq(t.projectId, input.projectId) : eq(schema.projects.companyId, invoice.companyId),
          input.from ? sql`${t.spentOn} >= ${input.from}` : undefined,
          input.to ? sql`${t.spentOn} <= ${input.to}` : undefined,
        ),
      )
      .orderBy(asc(t.spentOn), asc(t.id))

    const billable = entries.filter((e) => e.entry.billableRateMinor !== null)
    const tax = await taxSnapshot(ctx, input.taxRateId ?? null)

    // One line per group, and never one line at two rates: a rate that changed
    // between entries is a different line, so every line is quantity × its rate.
    const groups = new Map<string, { description: string; rate: number; seconds: number; entryIds: string[] }>()
    for (const { entry, projectName, taskTitle, personName } of billable) {
      const subject = input.groupBy === 'person' ? personName : input.groupBy === 'entry' ? (entry.description ?? taskTitle ?? projectName) : (taskTitle ?? projectName)
      const description =
        input.groupBy === 'entry'
          ? `${projectName} — ${subject} (${entry.spentOn})`
          : input.groupBy === 'person'
            ? `${projectName} — ${subject}`
            : `${projectName} — ${subject}`
      const key = input.groupBy === 'entry' ? entry.id : `${description}:${entry.billableRateMinor}`
      const group = groups.get(key) ?? { description, rate: entry.billableRateMinor!, seconds: 0, entryIds: [] }
      group.seconds += entry.durationSeconds!
      group.entryIds.push(entry.id)
      groups.set(key, group)
    }

    let position = await nextPosition(ctx, invoice.id)
    for (const group of groups.values()) {
      const lineId = newId()
      await ctx.tx.insert(schema.invoiceLines).values({
        id: lineId,
        organizationId: ctx.organizationId,
        invoiceId: invoice.id,
        position: position++,
        serviceId: null,
        description: group.description,
        quantity: String(secondsToHours(group.seconds)),
        unitAmountMinor: group.rate,
        discountPercent: null,
        ...tax,
        ...UNPRICED,
      })
      await ctx.tx.update(schema.timeEntries).set({ invoiceLineId: lineId, updatedAt: ctx.now }).where(inArray(schema.timeEntries.id, group.entryIds))
    }
    await recalculate(ctx, invoice.id)

    const updated = await getInvoice(ctx, invoice.id)
    const billed = {
      linesAdded: groups.size,
      entriesBilled: billable.length,
      secondsBilled: billable.reduce((sum, e) => sum + e.entry.durationSeconds!, 0),
      entriesWithoutRate: entries.length - billable.length,
    }
    await ctx.audit({
      action: 'invoice.updated',
      entityType: 'invoice',
      entityId: invoice.id,
      entityLabel: updated.title,
      changes: { billedTime: { from: null, to: `${billed.entriesBilled} entries in ${billed.linesAdded} lines` } },
    })
    await ctx.emit('invoice.updated', updated)
    return { ...updated, billed }
  },
})

// Rebilling expenses

const rebilledOutput = invoiceOutput.extend({
  rebilled: z.object({
    linesAdded: z.number().int(),
    /** What the expenses cost, before any markup. */
    costMinor: z.number().int(),
    /** What the client is charged for them. */
    chargedMinor: z.number().int(),
  }),
})

export const invoiceBillExpenses = defineProcedure({
  name: 'invoice.billExpenses',
  summary: "Rebill the client's unbilled billable expenses onto a draft invoice, at cost plus each one's markup",
  permission: 'invoice:update',
  input: z.object({
    id: z.uuid(),
    /** One project, or every project of this client. */
    projectId: z.uuid().optional(),
    /** Inclusive calendar dates, against the day the expense was incurred. */
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    /** The tax to charge. Omitted, each line keeps the tax the expense carried. */
    taxRateId: z.uuid().nullish(),
  }),
  output: rebilledOutput,
  http: { method: 'POST', path: '/invoices/{id}/expenses', successStatus: 201 },
  emits: ['invoice.updated'],
  async handler(ctx, input) {
    ctx.require('expense:read')
    const invoice = await loadInvoice(ctx, input.id, { lock: true })
    requireDraft(invoice)
    if (input.projectId) {
      const project = await loadProject(ctx, input.projectId)
      if (project.companyId !== invoice.companyId) throw new DomainError('That project is for a different client.', 'project_company_mismatch', 'projectId')
    }

    const expenses = await unbilledExpenses(ctx, invoice.companyId, invoice.currency, input)
    // An override applies to every line; otherwise each keeps the tax it was
    // incurred under, which is what the agency reclaimed and now charges on.
    const override = input.taxRateId === undefined ? null : await taxSnapshot(ctx, input.taxRateId ?? null)

    let position = await nextPosition(ctx, invoice.id)
    let costMinor = 0
    let chargedMinor = 0
    for (const { expense } of expenses) {
      const lineId = newId()
      const unitAmountMinor = rebillAmount(expense.amountMinor, fromNumeric(expense.markupPercent))
      await ctx.tx.insert(schema.invoiceLines).values({
        id: lineId,
        organizationId: ctx.organizationId,
        invoiceId: invoice.id,
        position: position++,
        serviceId: null,
        description: expense.description,
        quantity: '1',
        unitAmountMinor,
        discountPercent: null,
        ...(override ?? { taxRateId: expense.taxRateId, taxName: expense.taxName, taxRatePctSnapshot: expense.taxRatePctSnapshot }),
        ...UNPRICED,
      })
      await ctx.tx.update(schema.expenses).set({ invoiceLineId: lineId, updatedAt: ctx.now }).where(eq(schema.expenses.id, expense.id))
      costMinor += expense.amountMinor
      chargedMinor += unitAmountMinor
    }
    await recalculate(ctx, invoice.id)

    const updated = await getInvoice(ctx, invoice.id)
    await ctx.audit({
      action: 'invoice.updated',
      entityType: 'invoice',
      entityId: invoice.id,
      entityLabel: updated.title,
      changes: { rebilledExpenses: { from: null, to: `${expenses.length} expenses` } },
    })
    await ctx.emit('invoice.updated', updated)
    return { ...updated, rebilled: { linesAdded: expenses.length, costMinor, chargedMinor } }
  },
})

// Raising one from a quote

export const invoiceFromQuote = defineProcedure({
  name: 'invoice.fromQuote',
  summary: 'Raise a draft invoice from a sent or accepted quote, copying its lines exactly',
  permission: 'invoice:create',
  input: z.object({
    id: z.uuid(),
    title: requiredText(200, 'Title').optional(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
  }),
  output: invoiceOutput,
  http: { method: 'POST', path: '/quotes/{id}/invoice', successStatus: 201 },
  emits: ['invoice.created'],
  async handler(ctx, input) {
    const quote = await loadQuote(ctx, input.id)
    if (quote.status === 'draft') throw new DomainError('Send the quote before invoicing it.', 'quote_not_sent')
    if (quote.status === 'declined') throw new DomainError('That quote was declined.', 'quote_declined')
    refuseArchived(await loadCompany(ctx, quote.companyId), 'company')

    const id = newId()
    await ctx.tx.insert(schema.invoices).values({
      id,
      organizationId: ctx.organizationId,
      companyId: quote.companyId,
      contactId: quote.contactId,
      dealId: quote.dealId,
      projectId: quote.projectId,
      quoteId: quote.id,
      title: input.title ?? quote.title,
      currency: quote.currency,
      taxMode: quote.taxMode,
      paymentTermsDays: input.paymentTermsDays ?? (await defaultTerms(ctx)),
      discountPercent: quote.discountPercent,
      discountAmountMinor: quote.discountAmountMinor,
      notes: quote.notes,
      terms: quote.terms,
      createdBy: actingUserId(ctx),
    })
    // Copied as they stand, tax snapshots included: an invoice must say what
    // the client agreed to, whatever the catalogue says now.
    const q = schema.quoteLines
    for (const line of await ctx.tx.select().from(q).where(eq(q.quoteId, quote.id)).orderBy(asc(q.position), asc(q.id))) {
      const { id: _id, quoteId: _quoteId, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = line
      await ctx.tx.insert(schema.invoiceLines).values({ ...rest, id: newId(), invoiceId: id })
    }
    await recalculate(ctx, id)

    const invoice = await getInvoice(ctx, id)
    await ctx.audit({
      action: 'invoice.created',
      entityType: 'invoice',
      entityId: id,
      entityLabel: invoice.title,
      changes: { fromQuote: { from: null, to: quote.number } },
    })
    await ctx.emit('invoice.created', invoice)
    return invoice
  },
})

// Issuing

export const invoiceSend = defineProcedure({
  name: 'invoice.send',
  summary: 'Issue a draft invoice: it takes its number, dates, and exchange rate, and can no longer change',
  permission: 'invoice:send',
  input: z.object({
    id: z.uuid(),
    /** Defaults to today in the organization's time zone. */
    issueDate: z.iso.date().optional(),
    /** How many units of the base currency one unit of the invoice's currency is worth. */
    exchangeRate: exchangeRateInput.optional(),
    /** Email it to the client as well. */
    email: z.boolean().default(false),
    /** Where to send it. Defaults to the invoice's contact. */
    to: z.email().optional(),
  }),
  output: invoiceOutput,
  http: { method: 'POST', path: '/invoices/{id}/send' },
  emits: ['invoice.sent'],
  rateLimit: 'expensive',
  async handler(ctx, input) {
    const invoice = await loadInvoice(ctx, input.id, { lock: true })
    requireDraft(invoice)
    if ((await loadLines(ctx, invoice.id)).length === 0) throw new DomainError('Add at least one line before issuing.', 'no_lines')
    refuseArchived(await loadCompany(ctx, invoice.companyId), 'company')

    const issueDate = input.issueDate ?? (await today(ctx))
    const base = await baseCurrency(ctx)
    const rate = invoice.currency === base ? '1' : input.exchangeRate
    if (!rate) {
      throw new DomainError(`Enter the exchange rate from ${invoice.currency} to ${base}. It is fixed on the invoice when it is issued.`, 'exchange_rate_required', 'exchangeRate')
    }

    await recalculate(ctx, invoice.id)
    const priced = await loadInvoice(ctx, invoice.id)
    const totalBaseMinor = toSafeNumber(convert(BigInt(priced.totalMinor), priced.currency, base, rate))

    await ctx.tx
      .update(schema.invoices)
      .set({
        status: 'sent',
        number: await issueNumber(ctx, 'invoice'),
        issueDate,
        dueDate: addDays(issueDate, invoice.paymentTermsDays),
        sentAt: ctx.now,
        baseCurrency: base,
        exchangeRateToBase: rate,
        totalBaseMinor,
        updatedAt: ctx.now,
      })
      .where(eq(schema.invoices.id, invoice.id))

    const sent = await getInvoice(ctx, invoice.id)
    await ctx.audit({
      action: 'invoice.sent',
      entityType: 'invoice',
      entityId: invoice.id,
      entityLabel: `${sent.number} ${sent.title}`,
      changes: { status: { from: 'draft', to: 'sent' }, number: { from: null, to: sent.number } },
    })
    await ctx.emit('invoice.sent', sent)
    if (input.email) await emailDocument(ctx, sent, input.to)
    return getInvoice(ctx, invoice.id)
  },
})

export const invoiceEmail = defineProcedure({
  name: 'invoice.email',
  summary: 'Email an issued invoice to the client again, with its PDF attached',
  permission: 'invoice:send',
  input: z.object({ id: z.uuid(), to: z.email().optional() }),
  output: invoiceOutput,
  http: { method: 'POST', path: '/invoices/{id}/email' },
  // Sending again is not a new issuing: the invoice.sent event fired once, when it was issued.
  emits: [],
  rateLimit: 'expensive',
  async handler(ctx, input) {
    const invoice = await getInvoice(ctx, input.id)
    if (invoice.status === 'draft') throw new DomainError('Issue the invoice before emailing it.', 'invoice_not_sent')
    await emailDocument(ctx, invoice, input.to)
    return getInvoice(ctx, input.id)
  },
})

export const invoiceCancel = defineProcedure({
  name: 'invoice.cancel',
  summary: 'Cancel an issued invoice. It stays on the record, marked cancelled.',
  permission: 'invoice:cancel',
  input: z.object({ id: z.uuid(), reason: optionalText(2000) }),
  output: invoiceOutput,
  http: { method: 'POST', path: '/invoices/{id}/cancel' },
  emits: ['invoice.cancelled'],
  async handler(ctx, input) {
    const invoice = await loadInvoice(ctx, input.id, { lock: true })
    if (invoice.status === 'draft') throw new DomainError('A draft invoice is deleted, not cancelled.', 'invoice_not_sent')
    if (invoice.status === 'cancelled') throw new DomainError('This invoice is already cancelled.', 'invoice_cancelled')
    if (invoice.amountPaidMinor > 0) {
      throw new DomainError('Money has been received against this invoice. Refund the payment first.', 'invoice_has_payments')
    }
    await ctx.tx
      .update(schema.invoices)
      .set({ status: 'cancelled', cancelledAt: ctx.now, cancelReason: input.reason ?? null, updatedAt: ctx.now })
      .where(eq(schema.invoices.id, invoice.id))
    const cancelled = await getInvoice(ctx, invoice.id)
    await ctx.audit({
      action: 'invoice.cancelled',
      entityType: 'invoice',
      entityId: invoice.id,
      entityLabel: `${invoice.number} ${invoice.title}`,
      changes: { status: { from: invoice.status, to: 'cancelled' } },
    })
    await ctx.emit('invoice.cancelled', cancelled)
    return cancelled
  },
})

/**
 * Records that the client opened the invoice through their link.
 *
 * Called from the public page, where there is no session and no permission to
 * check -- holding the signed link is the authority. Viewing is recorded once;
 * opening it again changes nothing.
 */
export async function recordInvoiceView(ctx: ActorContext, id: string): Promise<Invoice> {
  const invoice = await loadInvoice(ctx, id, { lock: true })
  if (invoice.status === 'draft') throw new NotFoundError('Invoice', id)
  if (invoice.status === 'sent' && !invoice.viewedAt) {
    await ctx.tx.update(schema.invoices).set({ status: 'viewed', viewedAt: ctx.now, updatedAt: ctx.now }).where(eq(schema.invoices.id, id))
    const viewed = await getInvoice(ctx, id)
    await ctx.audit({ action: 'invoice.viewed', entityType: 'invoice', entityId: id, entityLabel: `${viewed.number} ${viewed.title}` })
    await ctx.emit('invoice.viewed', viewed)
    return viewed
  }
  return getInvoice(ctx, id)
}

/**
 * Emails the document with its PDF attached, after the change has committed:
 * a message cannot be unsent, so it must never go out for a transaction that
 * later rolls back. A failure is logged and the invoice stays issued -- send
 * it again rather than losing the number.
 */
async function emailDocument(ctx: ActorContext, invoice: Invoice, to?: string): Promise<void> {
  const address = to ?? (await contactEmail(ctx, invoice.contactId)) ?? (await companyEmail(ctx, invoice.companyId))
  if (!address) {
    throw new DomainError('No email address: choose a contact for this invoice, or give an address to send to.', 'no_email_address', 'to')
  }
  await ctx.tx.update(schema.invoices).set({ emailTo: address, emailSentAt: ctx.now, updatedAt: ctx.now }).where(eq(schema.invoices.id, invoice.id))
  await ctx.audit({
    action: 'invoice.emailed',
    entityType: 'invoice',
    entityId: invoice.id,
    entityLabel: `${invoice.number} ${invoice.title}`,
    changes: { emailTo: { from: invoice.emailTo, to: address } },
  })
  const payload = await documentEmailPayload(ctx, invoice, address)
  ctx.afterCommit(async () => {
    const { sendEmail } = await import('@workloom/emails')
    await sendEmail(payload)
  })
}

async function contactEmail(ctx: ActorContext, contactId: string | null): Promise<string | null> {
  if (!contactId) return null
  const [row] = await ctx.tx.select({ email: schema.contacts.email }).from(schema.contacts).where(eq(schema.contacts.id, contactId)).limit(1)
  return row?.email ?? null
}

async function companyEmail(ctx: ActorContext, companyId: string): Promise<string | null> {
  const [row] = await ctx.tx.select({ email: schema.companies.email }).from(schema.companies).where(eq(schema.companies.id, companyId)).limit(1)
  return row?.email ?? null
}

/** Built inside the transaction, sent after it: the message never queries a rolled-back state. */
async function documentEmailPayload(ctx: ActorContext, invoice: Invoice, to: string) {
  const [{ invoiceEmail: template }, { renderDocumentPdf }, { documentPdfInput }] = await Promise.all([
    import('@workloom/emails'),
    import('@workloom/pdf'),
    import('./pdf.ts'),
  ])
  const pdf = await renderDocumentPdf(await documentPdfInput(ctx, invoice, 'invoice'))
  const organization = await organizationName(ctx)
  return {
    ...template({
      to,
      organization,
      number: invoice.number!,
      title: invoice.title,
      total: invoice.totalMinor,
      currency: invoice.currency,
      dueDate: invoice.dueDate!,
      url: invoice.publicUrl!,
    }),
    attachments: [{ filename: `${invoice.number}.pdf`, content: pdf, contentType: 'application/pdf' }],
  }
}

async function organizationName(ctx: ActorContext): Promise<string> {
  const [org] = await ctx.tx
    .select({ name: schema.organization.name, legalName: schema.organization.legalName })
    .from(schema.organization)
    .where(eq(schema.organization.id, ctx.organizationId))
    .limit(1)
  return org?.legalName || org?.name || 'Workloom'
}

export const invoiceDownload = defineProcedure({
  name: 'invoice.download',
  summary: 'A short-lived link to the invoice as a PDF',
  permission: 'invoice:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: z.object({ url: z.url(), expiresAt: z.date(), filename: z.string() }),
  http: { method: 'GET', path: '/invoices/{id}/pdf' },
  rateLimit: 'expensive',
  async handler(ctx, input) {
    const invoice = await loadInvoice(ctx, input.id)
    const expiresAt = new Date(ctx.now.getTime() + PDF_LINK_SECONDS * 1000)
    return { url: invoicePdfLink(ctx.organizationId, invoice.id, expiresAt), expiresAt, filename: pdfFilename(invoice) }
  },
})

const pdfFilename = (invoice: { number: string | null; title: string }) =>
  `${invoice.number ?? 'draft'}-${invoice.title.replace(/[^\w.-]+/g, '-')}.pdf`.slice(0, 120)

/**
 * Renders one organization's invoice, for a caller that has already been
 * authorised -- a signed PDF link, or a client's own link. Opens its own tenant
 * transaction, since neither caller has a session to build a context from.
 */
export async function renderInvoicePdf(organizationId: string, invoiceId: string): Promise<{ filename: string; bytes: Buffer } | null> {
  return withTenant(organizationId, async (tx) => {
    const ctx = buildContext({ organizationId, actor: { type: 'system', label: 'document pdf' }, role: null, permissions: new Set() }, tx)
    const [row] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).limit(1)
    if (!row) return null
    const invoice = await getInvoice(ctx, invoiceId)
    const [{ renderDocumentPdf }, { documentPdfInput }] = await Promise.all([import('@workloom/pdf'), import('./pdf.ts')])
    return { filename: pdfFilename(invoice), bytes: await renderDocumentPdf(await documentPdfInput(ctx, invoice, 'invoice')) }
  })
}

/** What the client sees when they open their link: the invoice, and who issued it. */
export type PublicInvoice = {
  invoice: Invoice
  issuer: { name: string; address: string | null; taxNumber: string | null; paymentInstructions: string | null }
  client: { name: string; address: string | null }
  dateFormat: string
}

/**
 * Opens a client's link: records the view and returns the invoice.
 *
 * There is no session here -- holding the signed link is the authority, and it
 * names the organization, so the read still happens inside that tenant's
 * transaction like every other read.
 */
export async function openInvoiceLink(token: string, now = new Date()): Promise<PublicInvoice | null> {
  const link = readDocumentToken(token)
  if (!link) return null
  try {
    return await withTenant(link.organizationId, async (tx) => {
      const ctx = buildContext(
        { organizationId: link.organizationId, actor: { type: 'system', label: 'invoice link' }, role: null, permissions: new Set(), now },
        tx,
      )
      const invoice = await recordInvoiceView(ctx, link.documentId)
      const [org] = await tx.select().from(schema.organization).where(eq(schema.organization.id, link.organizationId)).limit(1)
      const [company] = await tx.select().from(schema.companies).where(eq(schema.companies.id, invoice.companyId)).limit(1)
      return {
        invoice,
        client: { name: company?.name ?? invoice.companyName, address: company?.address ?? null },
        issuer: {
          name: org?.legalName || org?.name || 'Workloom',
          address: org?.billingAddress ?? null,
          taxNumber: org?.taxNumber ?? null,
          paymentInstructions: org?.paymentInstructions ?? null,
        },
        dateFormat: org?.dateFormat ?? 'DD/MM/YYYY',
      }
    })
  } catch (error) {
    if (error instanceof NotFoundError) return null
    throw error
  }
}
