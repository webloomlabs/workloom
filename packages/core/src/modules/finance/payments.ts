import { and, asc, desc, eq, inArray, lt, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { ConflictError, DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { convert, formatDecimal, parseDecimal, RATE_SCALE, toSafeNumber } from '../../money/money.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from '../crm/companies.ts'
import {
  actingUserId,
  baseCurrency,
  currencyCode,
  minorAmount,
  optionalFlag,
  optionalText,
  pageInput,
  pageOutput,
  paginate,
  provided,
  refuseArchived,
} from '../crm/shared.ts'
import { exchangeRateInput, today } from './documents.ts'
import { getInvoice, loadInvoice } from './invoices.ts'
import { paidAt, settlementEvent, settlementStatus } from './settlement.ts'

/**
 * Money received, and money given back.
 *
 * A payment is recorded against a client and allocated across the invoices it
 * settles. Nothing here writes `invoices.amount_paid_minor`: a database trigger
 * recomputes it from the allocations and refuses an over-allocation, so
 * `amount_due = total - sum(allocations)` holds whatever writes to the tables.
 * What this module owns is the consequence -- which status the invoice now
 * reads as, and which event that announces.
 */

type PaymentRow = typeof schema.payments.$inferSelect

/**
 * Any change to an allocation can move the invoice it touches into any settled
 * state, so every procedure that allocates declares all four. Which one fires,
 * if any, is `settlementEvent`'s decision.
 */
const SETTLES = ['invoice.partially_paid', 'invoice.paid', 'invoice.overdue', 'invoice.refunded'] as const

/** An exchange rate as stored, in shortest exact form. Eight places, not four. */
const asRate = (value: string) => formatDecimal(parseDecimal(value, RATE_SCALE), RATE_SCALE)

// Reads

const allocationOutput = z.object({
  id: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNumber: z.string().nullable(),
  invoiceTitle: z.string(),
  amountMinor: z.number().int(),
  createdAt: z.date(),
})

export const paymentOutput = z.object({
  id: z.uuid(),
  /** A refund is the same record with the money going the other way. */
  kind: z.enum(schema.PAYMENT_KINDS),
  companyId: z.uuid(),
  companyName: z.string(),
  receivedOn: z.iso.date(),
  method: z.enum(schema.PAYMENT_METHODS),
  reference: z.string().nullable(),
  currency: z.string().length(3),
  /** Always positive; `kind` says which way it went. */
  amountMinor: z.number().int(),
  /** How much of it has been put against invoices. */
  allocatedMinor: z.number().int(),
  /** The rest: money on account, waiting for an invoice. */
  unallocatedMinor: z.number().int(),
  baseCurrency: z.string().length(3),
  exchangeRateToBase: z.string(),
  amountBaseMinor: z.number().int(),
  notes: z.string().nullable(),
  allocations: z.array(allocationOutput),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type Payment = z.infer<typeof paymentOutput>

function presentPayment(row: PaymentRow, companyName: string, allocations: Payment['allocations']): Payment {
  const allocatedMinor = allocations.reduce((sum, a) => sum + a.amountMinor, 0)
  return {
    id: row.id,
    kind: row.kind as Payment['kind'],
    companyId: row.companyId,
    companyName,
    receivedOn: row.receivedOn,
    method: row.method as Payment['method'],
    reference: row.reference,
    currency: row.currency,
    amountMinor: row.amountMinor,
    allocatedMinor,
    unallocatedMinor: row.amountMinor - allocatedMinor,
    baseCurrency: row.baseCurrency,
    exchangeRateToBase: asRate(row.exchangeRateToBase),
    amountBaseMinor: row.amountBaseMinor,
    notes: row.notes,
    allocations,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function loadAllocations(ctx: ActorContext, paymentIds: string[]): Promise<Map<string, Payment['allocations']>> {
  const byPayment = new Map<string, Payment['allocations']>()
  if (paymentIds.length === 0) return byPayment
  const a = schema.paymentAllocations
  const rows = await ctx.tx
    .select({ allocation: a, number: schema.invoices.number, title: schema.invoices.title })
    .from(a)
    .innerJoin(schema.invoices, eq(schema.invoices.id, a.invoiceId))
    .where(inArray(a.paymentId, paymentIds))
    .orderBy(asc(a.createdAt), asc(a.id))
  for (const row of rows) {
    const list = byPayment.get(row.allocation.paymentId) ?? []
    list.push({
      id: row.allocation.id,
      invoiceId: row.allocation.invoiceId,
      invoiceNumber: row.number,
      invoiceTitle: row.title,
      amountMinor: row.allocation.amountMinor,
      createdAt: row.allocation.createdAt,
    })
    byPayment.set(row.allocation.paymentId, list)
  }
  return byPayment
}

function selectPayments(ctx: ActorContext) {
  return ctx.tx
    .select({ payment: schema.payments, companyName: schema.companies.name })
    .from(schema.payments)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.payments.companyId))
}

export async function getPayment(ctx: ActorContext, id: string): Promise<Payment> {
  const [row] = await selectPayments(ctx).where(eq(schema.payments.id, id)).limit(1)
  if (!row) throw new NotFoundError('Payment', id)
  return presentPayment(row.payment, row.companyName, (await loadAllocations(ctx, [id])).get(id) ?? [])
}

export async function loadPayment(ctx: ActorContext, id: string, options: { lock?: boolean } = {}): Promise<PaymentRow> {
  const query = ctx.tx.select().from(schema.payments).where(eq(schema.payments.id, id)).limit(1)
  const [row] = options.lock ? await query.for('update') : await query
  if (!row) throw new NotFoundError('Payment', id)
  return row
}

export const paymentList = defineProcedure({
  name: 'payment.list',
  summary: 'Payments and refunds, newest first, filtered by client, invoice, or date',
  permission: 'payment:read',
  readOnly: true,
  input: z.object({
    companyId: z.uuid().optional(),
    /** Only payments allocated to this invoice. */
    invoiceId: z.uuid().optional(),
    kind: z.enum(schema.PAYMENT_KINDS).optional(),
    /** Inclusive calendar dates against the day the money moved. */
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    /** Only payments with money still sitting on account. */
    unallocated: optionalFlag,
    ...pageInput,
  }),
  output: pageOutput(paymentOutput),
  http: { method: 'GET', path: '/payments' },
  async handler(ctx, input) {
    const p = schema.payments
    if (input.companyId) await loadCompany(ctx, input.companyId)
    if (input.invoiceId) await loadInvoice(ctx, input.invoiceId)
    const allocated = sql`(select coalesce(sum(a.amount_minor), 0) from payment_allocations a where a.payment_id = ${p.id})`
    const conditions: Array<SQL | undefined> = [
      input.companyId ? eq(p.companyId, input.companyId) : undefined,
      input.invoiceId
        ? sql`exists (select 1 from payment_allocations a where a.payment_id = ${p.id} and a.invoice_id = ${input.invoiceId})`
        : undefined,
      input.kind ? eq(p.kind, input.kind) : undefined,
      input.from ? sql`${p.receivedOn} >= ${input.from}` : undefined,
      input.to ? sql`${p.receivedOn} <= ${input.to}` : undefined,
      input.unallocated === undefined ? undefined : input.unallocated ? sql`${allocated} < ${p.amountMinor}` : sql`${allocated} >= ${p.amountMinor}`,
      input.cursor ? lt(p.id, input.cursor) : undefined,
    ]
    const rows = await selectPayments(ctx).where(and(...conditions)).orderBy(desc(p.id)).limit(input.limit + 1)
    const allocations = await loadAllocations(ctx, rows.map((r) => r.payment.id))
    return paginate(
      rows.map((r) => presentPayment(r.payment, r.companyName, allocations.get(r.payment.id) ?? [])),
      input.limit,
    )
  },
})

export const paymentGet = defineProcedure({
  name: 'payment.get',
  summary: 'One payment, with what it was put against',
  permission: 'payment:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: paymentOutput,
  http: { method: 'GET', path: '/payments/{id}' },
  async handler(ctx, input) {
    return getPayment(ctx, input.id)
  },
})

// Settling invoices

/** What refunds have given back against an invoice. */
async function refundedAgainst(ctx: ActorContext, invoiceId: string): Promise<number> {
  const a = schema.paymentAllocations
  const [row] = await ctx.tx
    .select({ total: sql<number>`coalesce(sum(${a.amountMinor}), 0)::int` })
    .from(a)
    .innerJoin(schema.payments, eq(schema.payments.id, a.paymentId))
    .where(and(eq(a.invoiceId, invoiceId), eq(schema.payments.kind, 'refund')))
  return row?.total ?? 0
}

/**
 * Brings one invoice's status into line with what it has been paid.
 *
 * Reads `amount_paid_minor` back rather than computing it: by the time this
 * runs, the allocation trigger has already set it, and reading it is what
 * proves the two agree.
 */
export async function settleInvoice(ctx: ActorContext, invoiceId: string, on?: string): Promise<void> {
  const invoice = await loadInvoice(ctx, invoiceId)
  // A draft has nothing to settle, and a cancelled invoice is closed.
  if (invoice.status === 'draft' || invoice.status === 'cancelled') return

  const status = settlementStatus({
    totalMinor: invoice.totalMinor,
    amountPaidMinor: invoice.amountPaidMinor,
    refundedMinor: await refundedAgainst(ctx, invoiceId),
    dueDate: invoice.dueDate,
    viewed: invoice.viewedAt !== null,
    today: on ?? (await today(ctx)),
  })
  const settledAt = paidAt(status, invoice.paidAt, ctx.now)
  if (status === invoice.status && settledAt?.getTime() === invoice.paidAt?.getTime()) return

  await ctx.tx.update(schema.invoices).set({ status, paidAt: settledAt, updatedAt: ctx.now }).where(eq(schema.invoices.id, invoiceId))

  const event = settlementEvent(invoice.status, status)
  if (!event) return
  const settled = await getInvoice(ctx, invoiceId)
  await ctx.audit({
    action: event,
    entityType: 'invoice',
    entityId: invoiceId,
    entityLabel: `${settled.number} ${settled.title}`,
    changes: { status: { from: invoice.status, to: status } },
  })
  await ctx.emit(event, settled)
}

/**
 * The invoices a payment touches, settled in a fixed order.
 *
 * Sorted, because two payments landing on the same pair of invoices at the same
 * moment would otherwise lock them in opposite orders and deadlock.
 */
async function settleAll(ctx: ActorContext, invoiceIds: Iterable<string>): Promise<void> {
  for (const id of [...new Set(invoiceIds)].sort()) await settleInvoice(ctx, id)
}

// Recording

const allocationInput = z.object({
  invoiceId: z.uuid(),
  /** Omit to put as much against this invoice as it still owes. */
  amountMinor: minorAmount.optional(),
})

/**
 * Puts part of a payment against an invoice.
 *
 * The invoice is locked first: what is still owed decides how much fits, and
 * two payments arriving together must not both be told the same thing.
 */
async function allocate(
  ctx: ActorContext,
  payment: PaymentRow,
  request: z.infer<typeof allocationInput>,
  remaining: number,
  field: string,
): Promise<number> {
  const invoice = await loadInvoice(ctx, request.invoiceId, { lock: true })
  if (invoice.status === 'draft') {
    throw new DomainError('That invoice has not been issued yet.', 'invoice_not_sent', `${field}.invoiceId`)
  }
  if (invoice.currency !== payment.currency) {
    throw new DomainError(
      `The payment is in ${payment.currency} and invoice ${invoice.number} is in ${invoice.currency}. Record a separate payment in ${invoice.currency}.`,
      'currency_mismatch',
      `${field}.invoiceId`,
    )
  }
  const [existing] = await ctx.tx
    .select({ amountMinor: schema.paymentAllocations.amountMinor })
    .from(schema.paymentAllocations)
    .where(and(eq(schema.paymentAllocations.paymentId, payment.id), eq(schema.paymentAllocations.invoiceId, invoice.id)))
    .limit(1)
  if (existing) {
    throw new ConflictError(`This payment is already put against invoice ${invoice.number}. Change that allocation instead.`)
  }

  // A refund gives back what was paid; a payment settles what is owed.
  const room = payment.kind === 'refund' ? invoice.amountPaidMinor : invoice.totalMinor - invoice.amountPaidMinor
  const amountMinor = request.amountMinor ?? Math.min(remaining, Math.max(room, 0))
  if (amountMinor <= 0) {
    throw new DomainError(
      payment.kind === 'refund' ? `Nothing has been paid against invoice ${invoice.number}.` : `Invoice ${invoice.number} is already settled.`,
      'nothing_to_allocate',
      `${field}.amountMinor`,
    )
  }
  if (amountMinor > remaining) {
    throw new DomainError(
      `Only ${remaining} of this payment is left to allocate.`,
      'payment_over_allocated',
      `${field}.amountMinor`,
    )
  }
  if (amountMinor > room) {
    throw new DomainError(
      payment.kind === 'refund'
        ? `Invoice ${invoice.number} has only ${room} paid against it.`
        : `Invoice ${invoice.number} has only ${room} left to pay.`,
      'invoice_over_allocated',
      `${field}.amountMinor`,
    )
  }

  await ctx.tx.insert(schema.paymentAllocations).values({
    id: newId(),
    organizationId: ctx.organizationId,
    paymentId: payment.id,
    invoiceId: invoice.id,
    currency: payment.currency,
    amountMinor,
  })
  return amountMinor
}

/** What one unit of `currency` is worth in the base currency, and the amount converted. */
async function inBaseCurrency(ctx: ActorContext, currency: string, amountMinor: number, given: string | undefined) {
  const base = await baseCurrency(ctx)
  const exchangeRateToBase = currency === base ? '1' : given
  if (!exchangeRateToBase) {
    throw new DomainError(`Enter the exchange rate from ${currency} to ${base}.`, 'exchange_rate_required', 'exchangeRate')
  }
  return {
    baseCurrency: base,
    exchangeRateToBase,
    amountBaseMinor: toSafeNumber(convert(BigInt(amountMinor), currency, base, exchangeRateToBase)),
  }
}

export const paymentRecord = defineProcedure({
  name: 'payment.record',
  summary: 'Record money received from a client, or refunded to them, and put it against their invoices',
  permission: 'payment:create',
  input: z.object({
    companyId: z.uuid(),
    amountMinor: minorAmount.refine((v) => v > 0, 'Enter the amount received.'),
    /** A refund gives money back and unsettles the invoices it is put against. */
    kind: z.enum(schema.PAYMENT_KINDS).default('payment'),
    /** Defaults to the currency of the invoices it settles, then to the base currency. */
    currency: currencyCode.optional(),
    /** Defaults to today in the organization's time zone. */
    receivedOn: z.iso.date().optional(),
    method: z.enum(schema.PAYMENT_METHODS).default('bank_transfer'),
    reference: optionalText(200),
    notes: optionalText(10_000),
    exchangeRate: exchangeRateInput.optional(),
    /** What it settles. Left out, the money sits on the client's account. */
    allocations: z.array(allocationInput).max(100).default([]),
  }),
  output: paymentOutput,
  http: { method: 'POST', path: '/payments', successStatus: 201 },
  emits: ['payment.recorded', ...SETTLES],
  async handler(ctx, input) {
    const company = await loadCompany(ctx, input.companyId)
    refuseArchived(company, 'company')

    // Taking the currency from the first invoice is what lets the invoice page
    // record a payment without asking a question it already knows the answer to.
    let currency = input.currency
    if (!currency && input.allocations[0]) currency = (await loadInvoice(ctx, input.allocations[0].invoiceId)).currency
    currency ??= await baseCurrency(ctx)

    const id = newId()
    await ctx.tx.insert(schema.payments).values({
      id,
      organizationId: ctx.organizationId,
      companyId: company.id,
      kind: input.kind,
      receivedOn: input.receivedOn ?? (await today(ctx)),
      method: input.method,
      reference: input.reference ?? null,
      currency,
      amountMinor: input.amountMinor,
      ...(await inBaseCurrency(ctx, currency, input.amountMinor, input.exchangeRate)),
      notes: input.notes ?? null,
      createdBy: actingUserId(ctx),
    })

    const payment = await loadPayment(ctx, id)
    let remaining = payment.amountMinor
    for (const [i, request] of input.allocations.entries()) {
      remaining -= await allocate(ctx, payment, request, remaining, `allocations.${i}`)
    }
    await settleAll(ctx, input.allocations.map((a) => a.invoiceId))

    const recorded = await getPayment(ctx, id)
    await ctx.audit({
      action: 'payment.recorded',
      entityType: 'payment',
      entityId: id,
      entityLabel: `${recorded.amountMinor} ${recorded.currency} from ${company.name}`,
    })
    await ctx.emit('payment.recorded', recorded)
    return recorded
  },
})

export const paymentUpdate = defineProcedure({
  name: 'payment.update',
  summary: 'Correct a recorded payment. Its amount cannot drop below what it is already put against.',
  permission: 'payment:update',
  input: z.object({
    id: z.uuid(),
    amountMinor: minorAmount.refine((v) => v > 0, 'Enter the amount received.').optional(),
    receivedOn: z.iso.date().optional(),
    method: z.enum(schema.PAYMENT_METHODS).optional(),
    reference: optionalText(200),
    notes: optionalText(10_000),
    exchangeRate: exchangeRateInput.optional(),
  }),
  output: paymentOutput,
  http: { method: 'PATCH', path: '/payments/{id}' },
  emits: ['payment.updated'],
  async handler(ctx, input) {
    const { id, exchangeRate, ...fields } = input
    const before = await loadPayment(ctx, id, { lock: true })
    const patch = provided(fields) as Partial<PaymentRow>
    const amountMinor = patch.amountMinor ?? before.amountMinor
    if (amountMinor !== before.amountMinor || exchangeRate !== undefined) {
      Object.assign(patch, await inBaseCurrency(ctx, before.currency, amountMinor, exchangeRate ?? before.exchangeRateToBase))
    }

    const changes = diff({ ...before, exchangeRateToBase: asRate(before.exchangeRateToBase) } as Record<string, unknown>, patch)
    if (!changes) return getPayment(ctx, id)

    // No invoice is re-settled: none of these fields change an allocation, and
    // the database refuses an amount that no longer covers what was allocated.
    // Turning a payment into a refund is not a correction -- delete it and
    // record the refund, so both movements of money stay on the record.
    await ctx.tx.update(schema.payments).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.payments.id, id))

    const payment = await getPayment(ctx, id)
    await ctx.audit({ action: 'payment.updated', entityType: 'payment', entityId: id, entityLabel: `${payment.amountMinor} ${payment.currency}`, changes })
    await ctx.emit('payment.updated', payment)
    return payment
  },
})

export const paymentDelete = defineProcedure({
  name: 'payment.delete',
  summary: 'Delete a payment recorded in error. The invoices it settled go back to owing.',
  permission: 'payment:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/payments/{id}' },
  emits: ['payment.deleted', 'invoice.partially_paid', 'invoice.paid', 'invoice.overdue'],
  async handler(ctx, input) {
    const payment = await getPayment(ctx, input.id)
    await loadPayment(ctx, input.id, { lock: true })
    // The allocations cascade, and the trigger re-settles each invoice as they go.
    await ctx.tx.delete(schema.payments).where(eq(schema.payments.id, input.id))
    await settleAll(ctx, payment.allocations.map((a) => a.invoiceId))
    await ctx.audit({
      action: 'payment.deleted',
      entityType: 'payment',
      entityId: payment.id,
      entityLabel: `${payment.amountMinor} ${payment.currency} from ${payment.companyName}`,
    })
    await ctx.emit('payment.deleted', payment)
    return { deleted: true }
  },
})

// Allocating money already received

export const paymentAllocate = defineProcedure({
  name: 'payment.allocate',
  summary: 'Put part of a payment against an invoice',
  permission: 'payment:update',
  input: allocationInput.extend({ id: z.uuid() }),
  output: paymentOutput,
  http: { method: 'POST', path: '/payments/{id}/allocations', successStatus: 201 },
  emits: ['payment.updated', ...SETTLES],
  async handler(ctx, input) {
    const { id, ...request } = input
    const payment = await loadPayment(ctx, id, { lock: true })
    const allocated = ((await loadAllocations(ctx, [id])).get(id) ?? []).reduce((sum, a) => sum + a.amountMinor, 0)
    await allocate(ctx, payment, request, payment.amountMinor - allocated, 'allocation')
    await settleInvoice(ctx, request.invoiceId)

    const updated = await getPayment(ctx, id)
    const invoice = updated.allocations.find((a) => a.invoiceId === request.invoiceId)
    await ctx.audit({
      action: 'payment.updated',
      entityType: 'payment',
      entityId: id,
      entityLabel: `${updated.amountMinor} ${updated.currency}`,
      changes: { allocations: { from: null, to: `${invoice?.amountMinor} to ${invoice?.invoiceNumber}` } },
    })
    await ctx.emit('payment.updated', updated)
    return updated
  },
})

export const paymentUnallocate = defineProcedure({
  name: 'payment.unallocate',
  summary: 'Take a payment back off an invoice. The money stays on the client account.',
  permission: 'payment:update',
  input: z.object({ id: z.uuid() }),
  output: paymentOutput,
  http: { method: 'DELETE', path: '/payment-allocations/{id}' },
  // Taking money back off an invoice cannot leave it refunded: the refund that
  // would say so is still allocated, and the total would go below zero.
  emits: ['payment.updated', 'invoice.partially_paid', 'invoice.paid', 'invoice.overdue'],
  async handler(ctx, input) {
    const a = schema.paymentAllocations
    const [allocation] = await ctx.tx.select().from(a).where(eq(a.id, input.id)).limit(1)
    if (!allocation) throw new NotFoundError('Payment allocation', input.id)
    await loadPayment(ctx, allocation.paymentId, { lock: true })
    await loadInvoice(ctx, allocation.invoiceId, { lock: true })

    await ctx.tx.delete(a).where(eq(a.id, allocation.id))
    await settleInvoice(ctx, allocation.invoiceId)

    const updated = await getPayment(ctx, allocation.paymentId)
    await ctx.audit({
      action: 'payment.updated',
      entityType: 'payment',
      entityId: allocation.paymentId,
      entityLabel: `${updated.amountMinor} ${updated.currency}`,
      changes: { allocations: { from: String(allocation.amountMinor), to: null } },
    })
    await ctx.emit('payment.updated', updated)
    return updated
  },
})

// The passing of time

/**
 * Marks invoices overdue, per organization, in its own time zone.
 *
 * The only place `overdue` is set. It runs from the worker's nightly
 * maintenance next to quote expiry, takes the same skip-locked scan, and is
 * safe to run repeatedly: the status function gives the same answer until
 * something about the invoice changes, and an unchanged status announces
 * nothing.
 */
export async function markOverdueInvoices(ctx: ActorContext): Promise<number> {
  const i = schema.invoices
  const on = await today(ctx)
  const due = await ctx.tx
    .select({ id: i.id })
    .from(i)
    .where(and(inArray(i.status, ['sent', 'viewed', 'partially_paid']), sql`${i.dueDate} < ${on}`))
    .for('update', { skipLocked: true })
  for (const { id } of due) await settleInvoice(ctx, id, on)
  return due.length
}
