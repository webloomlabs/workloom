import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Payments, refunds, expenses, and the overdue sweep.
 *
 * The ledger invariants are asserted after every case rather than in one test
 * of their own: `amount_due = total - sum(allocations)`, no allocation beyond
 * the invoice it settles, and no payment allocated beyond what was received.
 * Those are the three a client disputes.
 *
 * Generic guarantees (audit, events, cross-tenant 404s, permission refusal) are
 * covered for every procedure in procedures.test.ts.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let modules: typeof import('../src/modules/index.ts')

const ORG_A = '01a0bb00-0000-7000-8000-00000000000a'
let ownerA: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  modules = await import('../src/modules/index.ts')

  ownerA = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone, payment_terms_days) values
        (${ORG_A}::uuid, 'Org A', 'pay-a', 'AUD', 'Australia/Sydney', 14)`)
    await db.execute(sql`insert into "user" (id, name, email) values (${ownerA}::uuid, 'Owner A', 'p-a@example.com')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role) values (${core.newId()}::uuid, ${ORG_A}::uuid, ${ownerA}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

const owner = () => ({
  organizationId: ORG_A,
  actor: { type: 'user' as const, id: ownerA, label: 'owner' },
  role: 'owner' as const,
  permissions: core.permissionsForRole('owner'),
})

function run<T = any>(name: string, input: unknown, now?: Date): Promise<T> {
  return registry.executeProcedure(name, { ...owner(), input, ...(now ? { now } : {}) }) as Promise<T>
}

const unique = () => core.newId().slice(-8)
const company = async (input: Record<string, unknown> = {}) => (await run('company.create', { name: `Client ${unique()}`, ...input })).id as string

type Issued = { id: string; companyId: string; totalMinor: number; status: string }

/** An issued invoice for 1,000.00, dated into the past when it should be late. */
async function issued(
  options: { overdue?: boolean; dueOn?: string; totalMinor?: number; currency?: string; companyId?: string } = {},
): Promise<Issued> {
  const companyId = options.companyId ?? (await company())
  const issueDate = options.dueOn ?? (options.overdue ? '2020-01-01' : undefined)
  const draft = await run('invoice.create', {
    companyId,
    title: `Invoice ${unique()}`,
    currency: options.currency ?? 'AUD',
    // Issued on a chosen day with nothing to wait for, so the due date is that day.
    paymentTermsDays: issueDate ? 0 : 30,
    lines: [{ description: 'Design', unitAmountMinor: options.totalMinor ?? 1000_00 }],
  })
  return run('invoice.send', {
    id: draft.id,
    ...(issueDate ? { issueDate } : {}),
    ...(options.currency && options.currency !== 'AUD' ? { exchangeRate: '1.5' } : {}),
  })
}

const statusOf = async (id: string) => (await run('invoice.get', { id })).status as string
const invoice = (id: string) => run('invoice.get', { id })

/**
 * The three ledger invariants, over every invoice and payment in the
 * organization. Run after each case, so a break is attributed to the mutation
 * that caused it rather than found much later.
 */
async function assertLedger(): Promise<void> {
  const { rows } = await mod.withTenant(ORG_A, (tx) =>
    tx.execute<{ id: string; total: number; paid: number; allocated: number }>(sql`
      select i.id,
             i.total_minor::int as total,
             i.amount_paid_minor::int as paid,
             coalesce(sum(case when p.kind = 'refund' then -a.amount_minor else a.amount_minor end), 0)::int as allocated
        from invoices i
        left join payment_allocations a on a.invoice_id = i.id
        left join payments p on p.id = a.payment_id
       group by i.id`),
  )
  for (const row of rows) {
    expect(row.paid, `invoice ${row.id}: amount paid disagrees with its allocations`).toBe(row.allocated)
    expect(row.paid, `invoice ${row.id}: allocated beyond its total`).toBeLessThanOrEqual(row.total)
    expect(row.paid, `invoice ${row.id}: refunded below nothing`).toBeGreaterThanOrEqual(0)
  }

  const { rows: over } = await mod.withTenant(ORG_A, (tx) =>
    tx.execute<{ id: string }>(sql`
      select p.id from payments p
        join payment_allocations a on a.payment_id = p.id
       group by p.id, p.amount_minor
      having sum(a.amount_minor) > p.amount_minor`),
  )
  expect(over.map((r) => r.id), 'payments allocated beyond what was received').toEqual([])
}

// Every case in this file, including the ones that expect a refusal.
afterEach(assertLedger)

/** The reason Postgres gave, which the driver hides behind "Failed query". */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    type Wrapped = { message?: string; cause?: unknown } | undefined
    let current: Wrapped = error as Wrapped
    const messages: string[] = []
    for (let depth = 0; current && depth < 4; depth++) {
      if (current.message) messages.push(current.message)
      current = current.cause as typeof current
    }
    return messages.join(' | ')
  }
  throw new Error('expected the database to refuse this')
}

// Events written by the last mutation, newest last.
async function eventsFor(entityId: string): Promise<string[]> {
  const { rows } = await mod.withTenant(ORG_A, (tx) =>
    tx.execute<{ type: string }>(sql`select type from events where data->>'id' = ${entityId} order by id`),
  )
  return rows.map((r) => r.type)
}

describe('settling an invoice', () => {
  it('goes from owing to part paid to paid, announcing each once', async () => {
    const it0 = await issued()
    expect(it0.status).toBe('sent')

    await run('payment.record', { companyId: it0.companyId, amountMinor: 400_00, allocations: [{ invoiceId: it0.id }] })
    const part = await invoice(it0.id)
    expect(part.status).toBe('partially_paid')
    expect(part.amountPaidMinor).toBe(400_00)
    expect(part.amountDueMinor).toBe(600_00)
    expect(part.paidAt, 'not paid until it is paid in full').toBeNull()

    await run('payment.record', { companyId: it0.companyId, amountMinor: 600_00, allocations: [{ invoiceId: it0.id }] })
    const paid = await invoice(it0.id)
    expect(paid.status).toBe('paid')
    expect(paid.amountDueMinor).toBe(0)
    expect(paid.paidAt).toBeInstanceOf(Date)

    expect(await eventsFor(it0.id)).toEqual(['invoice.created', 'invoice.sent', 'invoice.partially_paid', 'invoice.paid'])
  })

  it('takes as much as the invoice still owes when no amount is given', async () => {
    const target = await issued()
    await run('payment.record', { companyId: target.companyId, amountMinor: 250_00, allocations: [{ invoiceId: target.id }] })
    // 1,500.00 against 750.00 still owing: only what fits is allocated.
    const payment = await run('payment.record', { companyId: target.companyId, amountMinor: 1500_00, allocations: [{ invoiceId: target.id }] })
    expect(payment.allocatedMinor).toBe(750_00)
    expect(payment.unallocatedMinor).toBe(750_00)
    expect(await statusOf(target.id)).toBe('paid')
  })

  it('settles several invoices from one payment', async () => {
    const companyId = await company()
    const first = await issued({ companyId })
    const second = await issued({ companyId })
    const payment = await run('payment.record', {
      companyId,
      amountMinor: 2000_00,
      allocations: [{ invoiceId: first.id }, { invoiceId: second.id }],
    })
    expect(payment.allocations).toHaveLength(2)
    expect(payment.unallocatedMinor).toBe(0)
    expect(await statusOf(first.id)).toBe('paid')
    expect(await statusOf(second.id)).toBe('paid')
  })

  it('keeps money on account until there is an invoice for it', async () => {
    const companyId = await company()
    const payment = await run('payment.record', { companyId, amountMinor: 500_00, reference: 'Deposit' })
    expect(payment.allocatedMinor).toBe(0)
    expect(payment.unallocatedMinor).toBe(500_00)

    const later = await issued({ companyId, totalMinor: 500_00 })
    await run('payment.allocate', { id: payment.id, invoiceId: later.id })
    expect(await statusOf(later.id)).toBe('paid')

    const [onAccount] = (await run('payment.list', { companyId, unallocated: true })).data
    expect(onAccount, 'nothing is on account once it is all allocated').toBeUndefined()
  })

  it('puts an invoice back to owing when an allocation is taken off', async () => {
    const target = await issued()
    const payment = await run('payment.record', { companyId: target.companyId, amountMinor: 1000_00, allocations: [{ invoiceId: target.id }] })
    expect(await statusOf(target.id)).toBe('paid')

    const after = await run('payment.unallocate', { id: payment.allocations[0].id })
    expect(after.unallocatedMinor).toBe(1000_00)
    const reopened = await invoice(target.id)
    expect(reopened.status).toBe('sent')
    expect(reopened.amountPaidMinor).toBe(0)
    expect(reopened.paidAt, 'no longer paid, so no date it was paid').toBeNull()
  })
})

describe('what the ledger refuses', () => {
  it('refuses to allocate more of a payment than was received', async () => {
    const target = await issued()
    await expect(
      run('payment.record', { companyId: target.companyId, amountMinor: 100_00, allocations: [{ invoiceId: target.id, amountMinor: 500_00 }] }),
    ).rejects.toMatchObject({ code: 'payment_over_allocated' })
  })

  it('refuses to allocate more to an invoice than it asks for', async () => {
    const target = await issued()
    await expect(
      run('payment.record', { companyId: target.companyId, amountMinor: 5000_00, allocations: [{ invoiceId: target.id, amountMinor: 1500_00 }] }),
    ).rejects.toMatchObject({ code: 'invoice_over_allocated' })
  })

  it('refuses a second allocation of the same payment to the same invoice', async () => {
    const target = await issued()
    const payment = await run('payment.record', { companyId: target.companyId, amountMinor: 1000_00, allocations: [{ invoiceId: target.id, amountMinor: 100_00 }] })
    await expect(run('payment.allocate', { id: payment.id, invoiceId: target.id, amountMinor: 100_00 })).rejects.toThrow(/already put against/)
  })

  it('refuses money against a draft invoice', async () => {
    const companyId = await company()
    const draft = await run('invoice.create', { companyId, title: 'Not yet issued', lines: [{ description: 'Design', unitAmountMinor: 100_00 }] })
    await expect(run('payment.record', { companyId, amountMinor: 100_00, allocations: [{ invoiceId: draft.id }] })).rejects.toMatchObject({
      code: 'invoice_not_sent',
    })
  })

  it('refuses to pay an invoice in another currency', async () => {
    const companyId = await company()
    const target = await issued({ companyId, currency: 'JPY' })
    await expect(
      run('payment.record', { companyId, currency: 'AUD', amountMinor: 100_00, allocations: [{ invoiceId: target.id }] }),
    ).rejects.toMatchObject({ code: 'currency_mismatch' })
  })

  it('refuses an allocation in another currency in raw SQL, by foreign key', async () => {
    // Not a service rule: the allocation's currency is part of the key to both
    // sides, so there is no way to write one that straddles two currencies.
    const companyId = await company()
    const target = await issued({ companyId, currency: 'JPY' })
    const payment = await run('payment.record', { companyId, currency: 'AUD', amountMinor: 100_00 })
    const why = await refusal(
      mod.withTenant(ORG_A, (tx) =>
        tx.execute(sql`
          insert into payment_allocations (id, organization_id, payment_id, invoice_id, currency, amount_minor)
          values (${core.newId()}::uuid, ${ORG_A}::uuid, ${payment.id}::uuid, ${target.id}::uuid, 'AUD', 100)`),
      ),
    )
    expect(why).toMatch(/payment_allocations_invoice_fk/)
  })

  it('refuses an over-allocation written directly to the table', async () => {
    const target = await issued()
    const payment = await run('payment.record', { companyId: target.companyId, amountMinor: 5000_00 })
    expect(
      await refusal(
        mod.withTenant(ORG_A, (tx) =>
          tx.execute(sql`
            insert into payment_allocations (id, organization_id, payment_id, invoice_id, currency, amount_minor)
            values (${core.newId()}::uuid, ${ORG_A}::uuid, ${payment.id}::uuid, ${target.id}::uuid, 'AUD', 200000)`),
        ),
      ),
    ).toMatch(/would be allocated 200000 against a total of 100000/)
  })

  it('refuses to have the settled amount set by hand', async () => {
    const target = await issued()
    expect(
      await refusal(mod.withTenant(ORG_A, (tx) => tx.execute(sql`update invoices set amount_paid_minor = 100 where id = ${target.id}::uuid`))),
    ).toMatch(/follows its payment allocations/)
  })

  it('refuses a payment that would leave it allocated beyond its amount', async () => {
    const target = await issued()
    const payment = await run('payment.record', { companyId: target.companyId, amountMinor: 1000_00, allocations: [{ invoiceId: target.id }] })
    expect(await refusal(run('payment.update', { id: payment.id, amountMinor: 500_00 }))).toMatch(/would be allocated 100000 of 50000/)
  })

  it('lets many payments race for one invoice without over-settling it', async () => {
    const target = await issued({ totalMinor: 500_00 })
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        run('payment.record', { companyId: target.companyId, amountMinor: 100_00, allocations: [{ invoiceId: target.id, amountMinor: 100_00 }] }),
      ),
    )
    // Eight lots of 100.00 arrive at once against 500.00. Exactly five fit, and
    // which five is the database's business; that three were turned away is not.
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(5)
    expect((await invoice(target.id)).amountPaidMinor).toBe(500_00)
    expect(await statusOf(target.id)).toBe('paid')
  })
})

describe('refunds', () => {
  it('unsettles an invoice and lets it be cancelled', async () => {
    const target = await issued()
    await run('payment.record', { companyId: target.companyId, amountMinor: 1000_00, allocations: [{ invoiceId: target.id }] })
    await expect(run('invoice.cancel', { id: target.id, reason: 'Wrong client' })).rejects.toMatchObject({ code: 'invoice_has_payments' })

    await run('payment.record', { companyId: target.companyId, kind: 'refund', amountMinor: 1000_00, allocations: [{ invoiceId: target.id }] })
    const refunded = await invoice(target.id)
    expect(refunded.status).toBe('refunded')
    expect(refunded.amountPaidMinor).toBe(0)
    expect(refunded.paidAt, 'it was paid once, and that stays true').toBeInstanceOf(Date)

    const cancelled = await run('invoice.cancel', { id: target.id, reason: 'Wrong client' })
    expect(cancelled.status).toBe('cancelled')
  })

  it('reads as part paid when only part of the money went back', async () => {
    const target = await issued()
    await run('payment.record', { companyId: target.companyId, amountMinor: 1000_00, allocations: [{ invoiceId: target.id }] })
    await run('payment.record', { companyId: target.companyId, kind: 'refund', amountMinor: 400_00, allocations: [{ invoiceId: target.id }] })
    const partly = await invoice(target.id)
    expect(partly.status).toBe('partially_paid')
    expect(partly.amountDueMinor).toBe(400_00)
  })

  it('refuses to give back more than was ever paid', async () => {
    const target = await issued()
    await run('payment.record', { companyId: target.companyId, amountMinor: 300_00, allocations: [{ invoiceId: target.id }] })
    await expect(
      run('payment.record', { companyId: target.companyId, kind: 'refund', amountMinor: 900_00, allocations: [{ invoiceId: target.id, amountMinor: 900_00 }] }),
    ).rejects.toMatchObject({ code: 'invoice_over_allocated' })
  })

  it('puts the invoice back to paid when a refund is deleted', async () => {
    const target = await issued()
    await run('payment.record', { companyId: target.companyId, amountMinor: 1000_00, allocations: [{ invoiceId: target.id }] })
    const refund = await run('payment.record', { companyId: target.companyId, kind: 'refund', amountMinor: 1000_00, allocations: [{ invoiceId: target.id }] })
    expect(await statusOf(target.id)).toBe('refunded')

    await run('payment.delete', { id: refund.id })
    expect(await statusOf(target.id)).toBe('paid')
  })
})

describe('the overdue sweep', () => {
  const sweep = (now?: Date) =>
    mod.withTenant(ORG_A, (tx) =>
      modules.markOverdueInvoices(
        registry.buildContext({ organizationId: ORG_A, actor: { type: 'job', label: 'overdue invoices' }, role: null, permissions: new Set(), ...(now ? { now } : {}) }, tx),
      ),
    )

  it('marks a late invoice once, and says so once', async () => {
    const late = await issued({ overdue: true })
    expect(late.status).toBe('sent')

    await sweep()
    expect(await statusOf(late.id)).toBe('overdue')
    expect(await eventsFor(late.id)).toEqual(['invoice.created', 'invoice.sent', 'invoice.overdue'])

    // Running again the next night changes nothing and announces nothing.
    await sweep()
    expect(await statusOf(late.id)).toBe('overdue')
    expect(await eventsFor(late.id)).toEqual(['invoice.created', 'invoice.sent', 'invoice.overdue'])
  })

  it('leaves an invoice that is not yet due alone', async () => {
    const current = await issued()
    await sweep()
    expect(await statusOf(current.id)).toBe('sent')
  })

  it('never sweeps one that is paid, or cancelled', async () => {
    const paid = await issued({ overdue: true })
    await run('payment.record', { companyId: paid.companyId, amountMinor: 1000_00, allocations: [{ invoiceId: paid.id }] })
    const cancelled = await issued({ overdue: true })
    await run('invoice.cancel', { id: cancelled.id })

    await sweep()
    expect(await statusOf(paid.id)).toBe('paid')
    expect(await statusOf(cancelled.id)).toBe('cancelled')
  })

  it('marks a part paid invoice overdue, because it is still late', async () => {
    const late = await issued({ overdue: true })
    await run('payment.record', { companyId: late.companyId, amountMinor: 200_00, allocations: [{ invoiceId: late.id }] })
    // The payment itself settles it: overdue outranks part paid.
    expect(await statusOf(late.id)).toBe('overdue')
    await sweep()
    expect(await statusOf(late.id)).toBe('overdue')
  })

  it('reads the due date in the organization time zone', async () => {
    // Just before midnight in Sydney on the due date: still the due date there,
    // already the next day in UTC. The invoice is not yet late.
    const due = await issued({ dueOn: '2026-09-17' })
    await sweep(new Date('2026-09-17T13:59:00Z'))
    expect(await statusOf(due.id)).toBe('sent')
    await sweep(new Date('2026-09-18T14:01:00Z'))
    expect(await statusOf(due.id)).toBe('overdue')
  })
})

describe('expenses', () => {
  const expense = (input: Record<string, unknown> = {}) =>
    run('expense.create', { description: `Hosting ${unique()}`, amountMinor: 100_00, ...input })

  it('costs the net amount and charges the tax on top', async () => {
    const gst = (await run('taxRate.create', { name: `GST ${unique()}`, rate: '10' })).id
    const recorded = await expense({ amountMinor: 100_00, taxRateId: gst })
    expect(recorded.amountMinor).toBe(100_00)
    expect(recorded.taxMinor).toBe(10_00)
    expect(recorded.totalMinor).toBe(110_00)
    expect(recorded.taxRate).toBe('10')
  })

  it('takes its client from its project', async () => {
    const companyId = await company()
    const projectId = (await run('project.create', { name: `Site ${unique()}`, companyId })).id
    const recorded = await expense({ projectId })
    expect(recorded.companyId).toBe(companyId)
  })

  it('rebills at cost plus the markup, and freezes once it has', async () => {
    const companyId = await company()
    const first = await expense({ companyId, amountMinor: 100_00, billable: true, markupPercent: '15' })
    await expense({ companyId, amountMinor: 50_00, billable: true }) // billable, at cost
    await expense({ companyId, amountMinor: 900_00 }) // not billable: never rebilled
    expect(first.rebillMinor).toBe(115_00)

    const draft = await run('invoice.create', { companyId, title: `Rebill ${unique()}` })
    const billed = await run('invoice.billExpenses', { id: draft.id })
    expect(billed.rebilled).toEqual({ linesAdded: 2, costMinor: 150_00, chargedMinor: 165_00 })
    expect(billed.totalMinor).toBe(165_00)

    await expect(run('expense.update', { id: first.id, amountMinor: 1_00 })).rejects.toMatchObject({ code: 'expense_invoiced' })
    await expect(run('expense.delete', { id: first.id })).rejects.toMatchObject({ code: 'expense_invoiced' })

    // Billing again finds nothing: they are spent.
    const again = await run('invoice.billExpenses', { id: draft.id })
    expect(again.rebilled.linesAdded).toBe(0)
  })

  it('releases a rebilled expense when its line is removed', async () => {
    const companyId = await company()
    const recorded = await expense({ companyId, billable: true })
    const draft = await run('invoice.create', { companyId, title: `Rebill ${unique()}` })
    const billed = await run('invoice.billExpenses', { id: draft.id })

    await run('invoiceLine.remove', { id: billed.lines[0].id })
    const freed = await run('expense.get', { id: recorded.id })
    expect(freed.invoiceLineId).toBeNull()
    expect((await run('expense.update', { id: recorded.id, supplier: 'Vultr' })).supplier).toBe('Vultr')
  })

  it('refuses a rebilled expense being changed in raw SQL', async () => {
    const companyId = await company()
    const recorded = await expense({ companyId, billable: true })
    const draft = await run('invoice.create', { companyId, title: `Rebill ${unique()}` })
    await run('invoice.billExpenses', { id: draft.id })
    expect(
      await refusal(mod.withTenant(ORG_A, (tx) => tx.execute(sql`update expenses set amount_minor = 1 where id = ${recorded.id}::uuid`))),
    ).toMatch(/has been rebilled and can no longer change/)
  })

  it('lists what is still billable', async () => {
    const companyId = await company()
    await expense({ companyId, billable: true })
    await expense({ companyId, billable: false })
    const billable = await run('expense.list', { companyId, billable: true, invoiced: false })
    expect(billable.data).toHaveLength(1)
  })
})
