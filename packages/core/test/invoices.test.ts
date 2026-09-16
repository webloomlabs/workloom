import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'
import { GOLDEN_FIXTURES } from '../src/tax/fixtures.ts'

/**
 * Invoices: the golden fixtures stored and read back, gapless numbering, an
 * issued invoice that cannot change, quotes copied without re-pricing, tracked
 * time billed at the rates it was logged at, the client's link and what it
 * records, and the email with its PDF.
 *
 * Generic guarantees (audit, events, cross-tenant 404s, permission refusal) are
 * covered for every procedure in procedures.test.ts.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let modules: typeof import('../src/modules/index.ts')
let emails: typeof import('@workloom/emails')
let pdf: typeof import('@workloom/pdf')

const ORG_A = '01a0aa00-0000-7000-8000-00000000000a'
const ORG_C = '01a0aa00-0000-7000-8000-00000000000c'
let ownerA: string
let ownerC: string
let developerA: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  modules = await import('../src/modules/index.ts')
  emails = await import('@workloom/emails')
  pdf = await import('@workloom/pdf')

  ownerA = core.newId()
  ownerC = core.newId()
  developerA = core.newId()

  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone, legal_name, billing_address, tax_number, payment_instructions, payment_terms_days) values
        (${ORG_A}::uuid, 'Org A', 'inv-a', 'AUD', 'Australia/Sydney', 'Webloom Labs Pty Ltd', E'1 Harbour St\\nSydney NSW 2000', 'ABN 12 345 678 901', 'Transfer to BSB 000-000, account 1234567.', 21),
        (${ORG_C}::uuid, 'Org C', 'inv-c', 'AUD', 'UTC', null, null, null, null, 14)`)
    await db.execute(sql`
      insert into "user" (id, name, email) values
        (${ownerA}::uuid, 'Owner A', 'i-a@example.com'),
        (${ownerC}::uuid, 'Owner C', 'i-c@example.com'),
        (${developerA}::uuid, 'Dev A', 'i-dev@example.com')`)
    await db.execute(sql`
      insert into member (id, organization_id, user_id, role) values
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${ownerA}::uuid, 'owner'),
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${developerA}::uuid, 'developer'),
        (${core.newId()}::uuid, ${ORG_C}::uuid, ${ownerC}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

type Role = 'owner' | 'developer'
const as = (organizationId: string, userId: string, role: Role) => ({
  organizationId,
  actor: { type: 'user' as const, id: userId, label: role },
  role,
  permissions: core.permissionsForRole(role),
})
const owner = () => as(ORG_A, ownerA, 'owner')
const developer = () => as(ORG_A, developerA, 'developer')

function run<T = any>(name: string, actor: ReturnType<typeof as>, input: unknown, now?: Date): Promise<T> {
  return registry.executeProcedure(name, { ...actor, input, ...(now ? { now } : {}) }) as Promise<T>
}

const unique = () => core.newId().slice(-8)
const company = async (input: Record<string, unknown> = {}, actor = owner()) =>
  (await run('company.create', actor, { name: `Client ${unique()}`, ...input })).id as string
const taxRate = async (rate = '10') => (await run('taxRate.create', owner(), { name: `Tax ${rate} ${unique()}`, rate })).id as string
const draft = async (input: Record<string, unknown> = {}, actor = owner()) =>
  run('invoice.create', actor, { companyId: await company({}, actor), title: `Invoice ${unique()}`, lines: [{ description: 'Design', unitAmountMinor: 1000_00 }], ...input })

describe('golden fixtures, stored as invoices and read back', () => {
  const rates = new Map<string, string>()
  const rateId = async (rate: string) => {
    if (!rates.has(rate)) rates.set(rate, await taxRate(rate))
    return rates.get(rate)!
  }
  const exchange: Record<string, string> = { AUD: '1', JPY: '0.0105', KWD: '4.9' }
  const totals = (document: any) => ({
    subtotalMinor: document.subtotalMinor,
    discountMinor: document.discountMinor,
    taxMinor: document.taxMinor,
    totalMinor: document.totalMinor,
  })

  it.each(GOLDEN_FIXTURES.map((f) => [f.name, f] as const))('%s', async (_, fixture) => {
    const { document, expected } = fixture
    const lines = []
    for (const l of document.lines) {
      lines.push({
        description: `Line ${lines.length + 1}`,
        quantity: l.quantity,
        unitAmountMinor: l.unitAmountMinor,
        discountPercent: l.discountPercent ?? null,
        taxRateId: l.taxRate === undefined ? null : await rateId(l.taxRate),
      })
    }
    const created = await draft({
      currency: document.currency,
      taxMode: document.taxMode,
      ...(document.discount && 'percent' in document.discount ? { discountPercent: document.discount.percent } : {}),
      ...(document.discount && 'amountMinor' in document.discount ? { discountAmountMinor: document.discount.amountMinor } : {}),
      lines,
    })
    expect(totals(created)).toEqual({
      subtotalMinor: expected.subtotalMinor,
      discountMinor: expected.discountMinor,
      taxMinor: expected.taxMinor,
      totalMinor: expected.totalMinor,
    })
    expect(created.lines.map((l: any) => ({ netMinor: l.netMinor, documentDiscountMinor: l.documentDiscountMinor, taxMinor: l.taxMinor, totalMinor: l.totalMinor }))).toEqual(
      expected.lines,
    )

    if (document.lines.length === 0) return
    const issued = await run('invoice.send', owner(), { id: created.id, exchangeRate: exchange[document.currency] })
    expect(totals(issued)).toEqual(totals(created))
    expect(totals(await run('invoice.get', owner(), { id: created.id }))).toEqual(totals(created))
  })
})

describe('issuing', () => {
  const inOrgC = () => as(ORG_C, ownerC, 'owner')

  it('gives 20 invoices issued at once 20 distinct numbers, with no gaps', async () => {
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push((await draft({}, inOrgC())).id)
    const failing = [(await draft({ lines: [] }, inOrgC())).id, (await draft({ currency: 'USD' }, inOrgC())).id]

    const results = await Promise.allSettled([...ids, ...failing].map((id) => run('invoice.send', inOrgC(), { id })))
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2)
    const numbers = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.number as string] : [])).sort()
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => `INV-${String(i + 1).padStart(4, '0')}`))
  })

  it('sets the due date from the payment terms, and the terms from the organization', async () => {
    const invoice = await draft()
    expect(invoice.paymentTermsDays).toBe(21)
    const issued = await run('invoice.send', owner(), { id: invoice.id, issueDate: '2026-09-16' })
    expect(issued).toMatchObject({ issueDate: '2026-09-16', dueDate: '2026-10-07', status: 'sent' })

    const shorter = await draft({ paymentTermsDays: 7 })
    expect((await run('invoice.send', owner(), { id: shorter.id, issueDate: '2026-09-16' })).dueDate).toBe('2026-09-23')
  })

  it('refuses an invoice with no lines, and a foreign currency with no rate', async () => {
    await expect(run('invoice.send', owner(), { id: (await draft({ lines: [] })).id })).rejects.toMatchObject({ code: 'no_lines' })
    await expect(run('invoice.send', owner(), { id: (await draft({ currency: 'USD' })).id })).rejects.toMatchObject({ code: 'exchange_rate_required' })
  })
})

describe('an issued invoice', () => {
  it('cannot be edited or deleted, only cancelled', async () => {
    const invoice = await draft()
    const issued = await run('invoice.send', owner(), { id: invoice.id })

    await expect(run('invoice.update', owner(), { id: invoice.id, title: 'Changed' })).rejects.toMatchObject({ code: 'invoice_not_draft' })
    await expect(run('invoiceLine.add', owner(), { id: invoice.id, description: 'More', unitAmountMinor: 1 })).rejects.toMatchObject({ code: 'invoice_not_draft' })
    await expect(run('invoiceLine.update', owner(), { id: issued.lines[0].id, quantity: '2' })).rejects.toMatchObject({ code: 'invoice_not_draft' })
    await expect(run('invoiceLine.remove', owner(), { id: issued.lines[0].id })).rejects.toMatchObject({ code: 'invoice_not_draft' })
    await expect(run('invoice.send', owner(), { id: invoice.id })).rejects.toMatchObject({ code: 'invoice_not_draft' })
    await expect(run('invoice.delete', owner(), { id: invoice.id })).rejects.toBeInstanceOf(core.ConflictError)

    const cancelled = await run('invoice.cancel', owner(), { id: invoice.id, reason: 'Raised in error' })
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Raised in error' })
    await expect(run('invoice.cancel', owner(), { id: invoice.id })).rejects.toMatchObject({ code: 'invoice_cancelled' })
  })

  it('refuses cancelling once money has been received', async () => {
    const invoice = await draft()
    const sent = await run('invoice.send', owner(), { id: invoice.id })
    await run('payment.record', owner(), { companyId: sent.companyId, amountMinor: 100, allocations: [{ invoiceId: invoice.id, amountMinor: 100 }] })
    await expect(run('invoice.cancel', owner(), { id: invoice.id })).rejects.toMatchObject({ code: 'invoice_has_payments' })
    // Refunding it is what frees it; that path is in payments.test.ts.
  })

  it('a draft is deleted rather than cancelled', async () => {
    const invoice = await draft()
    await expect(run('invoice.cancel', owner(), { id: invoice.id })).rejects.toMatchObject({ code: 'invoice_not_sent' })
    expect(await run('invoice.delete', owner(), { id: invoice.id })).toEqual({ deleted: true })
  })
})

describe('from a quote', () => {
  const quote = async (input: Record<string, unknown> = {}) =>
    run('quote.create', owner(), { companyId: await company(), title: `Quote ${unique()}`, lines: [{ description: 'Build', unitAmountMinor: 500_00 }], ...input })

  it('copies the lines exactly, and never prices them again', async () => {
    const gst = await taxRate('10')
    const service = await run('service.create', owner(), { name: `Retainer ${unique()}`, defaultPriceMinor: 100_00, defaultTaxRateId: gst })
    const accepted = await quote({ lines: [{ serviceId: service.id, quantity: '3' }], discountPercent: '10' })
    await run('quote.send', owner(), { id: accepted.id })
    await run('quote.accept', owner(), { id: accepted.id })

    const invoice = await run('invoice.fromQuote', owner(), { id: accepted.id })
    expect(invoice).toMatchObject({
      status: 'draft',
      number: null,
      quoteId: accepted.id,
      title: accepted.title,
      subtotalMinor: accepted.subtotalMinor,
      discountMinor: accepted.discountMinor,
      taxMinor: accepted.taxMinor,
      totalMinor: accepted.totalMinor,
    })
    expect(invoice.lines[0]).toMatchObject({ description: service.name, unitAmountMinor: 100_00, quantity: '3', taxRate: '10' })

    // The catalogue moves on; the invoice does not.
    await run('service.update', owner(), { id: service.id, defaultPriceMinor: 999_00 })
    await run('taxRate.archive', owner(), { id: gst })
    const reread = await run('invoice.get', owner(), { id: invoice.id })
    expect(reread.lines[0]).toMatchObject({ unitAmountMinor: 100_00, taxRate: '10' })
    expect(reread.totalMinor).toBe(accepted.totalMinor)
  })

  it('refuses a draft or declined quote, and allows several invoices from one quote', async () => {
    const draftQuote = await quote()
    await expect(run('invoice.fromQuote', owner(), { id: draftQuote.id })).rejects.toMatchObject({ code: 'quote_not_sent' })

    await run('quote.send', owner(), { id: draftQuote.id })
    const deposit = await run('invoice.fromQuote', owner(), { id: draftQuote.id, title: 'Deposit' })
    const balance = await run('invoice.fromQuote', owner(), { id: draftQuote.id, title: 'Balance' })
    expect(deposit.id).not.toBe(balance.id)
    expect((await run('invoice.list', owner(), { quoteId: draftQuote.id })).data).toHaveLength(2)

    const declined = await quote()
    await run('quote.send', owner(), { id: declined.id })
    await run('quote.decline', owner(), { id: declined.id })
    await expect(run('invoice.fromQuote', owner(), { id: declined.id })).rejects.toMatchObject({ code: 'quote_declined' })
  })
})

describe('billing tracked time', () => {
  const withTime = async () => {
    const companyId = await company()
    const projectId = (await run('project.create', owner(), { name: `P ${unique()}`, companyId })).id
    await run('rate.set', owner(), { billableRateMinor: 150_00, costRateMinor: 60_00 })
    return { companyId, projectId }
  }

  it('groups entries into lines at the rate each was logged at, and marks them billed', async () => {
    const { companyId, projectId } = await withTime()
    const task = await run('task.create', owner(), { projectId, title: 'Design' })
    await run('timeEntry.create', owner(), { taskId: task.id, durationSeconds: 5400, spentOn: '2026-09-01' })
    await run('timeEntry.create', owner(), { taskId: task.id, durationSeconds: 1800, spentOn: '2026-09-02' })
    // A different rate cannot share a line.
    await run('rate.set', owner(), { billableRateMinor: 200_00, costRateMinor: 60_00 })
    await run('timeEntry.create', owner(), { taskId: task.id, durationSeconds: 3600, spentOn: '2026-09-03' })
    // Not billable, and unrated time, are left alone.
    await run('timeEntry.create', owner(), { projectId, durationSeconds: 3600, billable: false })

    const invoice = await draft({ companyId, lines: [] })
    const billed = await run('invoice.billTime', owner(), { id: invoice.id, projectId, taxRateId: await taxRate('10') })
    expect(billed.billed).toMatchObject({ linesAdded: 2, entriesBilled: 3, secondsBilled: 10_800 })
    // 2 hours at 150.00, then 1 hour at 200.00.
    expect(billed.lines.map((l: any) => [l.quantity, l.unitAmountMinor, l.netMinor])).toEqual([
      ['2', 150_00, 300_00],
      ['1', 200_00, 200_00],
    ])
    expect(billed.totalMinor).toBe(550_00)

    // Billed time is frozen, and is not offered again.
    const entries = await run('timeEntry.list', owner(), { projectId, invoiced: 'true' })
    expect(entries.data).toHaveLength(3)
    expect(entries.data.every((e: { invoiced: boolean }) => e.invoiced)).toBe(true)
    await expect(run('timeEntry.update', owner(), { id: entries.data[0].id, durationSeconds: 60 })).rejects.toMatchObject({ code: 'time_entry_invoiced' })
    await expect(run('timeEntry.delete', owner(), { id: entries.data[0].id })).rejects.toMatchObject({ code: 'time_entry_invoiced' })

    const again = await run('invoice.billTime', owner(), { id: (await draft({ companyId, lines: [] })).id, projectId })
    expect(again.billed).toMatchObject({ linesAdded: 0, entriesBilled: 0 })
  })

  it('releases the time when the line goes, so it can be billed again', async () => {
    const { companyId, projectId } = await withTime()
    await run('timeEntry.create', owner(), { projectId, durationSeconds: 3600 })
    const invoice = await draft({ companyId, lines: [] })
    const billed = await run('invoice.billTime', owner(), { id: invoice.id, projectId })
    expect(billed.lines).toHaveLength(1)

    await run('invoiceLine.remove', owner(), { id: billed.lines[0].id })
    expect((await run('timeEntry.list', owner(), { projectId, invoiced: 'false' })).data).toHaveLength(1)
    // Deleting the whole draft releases it too.
    const second = await draft({ companyId, lines: [] })
    await run('invoice.billTime', owner(), { id: second.id, projectId })
    await run('invoice.delete', owner(), { id: second.id })
    expect((await run('timeEntry.list', owner(), { projectId, invoiced: 'false' })).data).toHaveLength(1)
  })

  it('counts time it cannot bill, and stays within the client and the currency', async () => {
    const { companyId, projectId } = await withTime()
    // Logged before any rate existed.
    await mod.withTenant(ORG_A, (tx) =>
      tx.execute(sql`insert into time_entries (id, organization_id, user_id, project_id, spent_on, duration_seconds, billable, currency)
        values (${core.newId()}::uuid, ${ORG_A}::uuid, ${ownerA}::uuid, ${projectId}::uuid, '2026-09-01', 3600, true, 'AUD')`),
    )
    const invoice = await draft({ companyId, lines: [] })
    expect((await run('invoice.billTime', owner(), { id: invoice.id, projectId })).billed).toMatchObject({ linesAdded: 0, entriesBilled: 0, entriesWithoutRate: 1 })

    const otherProject = (await run('project.create', owner(), { name: `Other ${unique()}`, companyId: await company() })).id
    await expect(run('invoice.billTime', owner(), { id: invoice.id, projectId: otherProject })).rejects.toMatchObject({ code: 'project_company_mismatch' })
  })
})

describe("the client's link", () => {
  it('names its own tenant and document, and refuses anything altered', async () => {
    const invoice = await draft()
    expect(invoice.publicUrl).toBeNull()
    const issued = await run('invoice.send', owner(), { id: invoice.id })
    const token = issued.publicUrl.split('/i/')[1]

    expect(modules.readDocumentToken(token)).toEqual({ kind: 'invoice', organizationId: ORG_A, documentId: invoice.id })
    expect(modules.readDocumentToken(`${token}x`)).toBeNull()
    expect(modules.readDocumentToken('not-a-token')).toBeNull()
    // A token for one invoice does not open another.
    const other = await run('invoice.send', owner(), { id: (await draft()).id })
    expect(modules.readDocumentToken(other.publicUrl.split('/i/')[1])?.documentId).toBe(other.id)
  })

  it('records the first view, once, and never opens a draft', async () => {
    const invoice = await draft()
    const asClient = async (id: string, now?: Date) =>
      mod.withTenant(ORG_A, (tx) =>
        modules.recordInvoiceView(
          registry.buildContext({ organizationId: ORG_A, actor: { type: 'system', label: 'invoice link' }, role: null, permissions: new Set(), ...(now ? { now } : {}) }, tx),
          id,
        ),
      )

    await expect(asClient(invoice.id)).rejects.toBeInstanceOf(core.NotFoundError)
    await run('invoice.send', owner(), { id: invoice.id })

    const opened = new Date('2026-09-17T02:00:00Z')
    expect(await asClient(invoice.id, opened)).toMatchObject({ status: 'viewed', viewedAt: opened })
    // Opening it again changes nothing.
    expect(await asClient(invoice.id, new Date('2026-09-18T02:00:00Z'))).toMatchObject({ status: 'viewed', viewedAt: opened })

    const { rows } = await mod.withTenant(ORG_A, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from events where type = 'invoice.viewed' and data->>'id' = ${invoice.id}`),
    )
    expect(rows[0]!.n).toBe(1)
  })
})

describe('the email', () => {
  it('goes to the client with the invoice attached, and records where it went', async () => {
    emails.clearSentEmails()
    const companyId = await company({ email: 'accounts@example.test' })
    const invoice = await draft({ companyId })
    const sent = await run('invoice.send', owner(), { id: invoice.id, email: true })

    const [message] = emails.sentEmails()
    expect(message).toMatchObject({ to: 'accounts@example.test', subject: expect.stringContaining(sent.number) })
    expect(message!.subject).toContain('Webloom Labs Pty Ltd')
    const attachment = message!.attachments![0]!
    expect(attachment).toMatchObject({ filename: `${sent.number}.pdf`, contentType: 'application/pdf' })
    expect(attachment.content.subarray(0, 5).toString()).toBe('%PDF-')
    expect(message!.text).toContain(sent.publicUrl)
    expect(await run('invoice.get', owner(), { id: invoice.id })).toMatchObject({ emailTo: 'accounts@example.test', emailSentAt: expect.any(Date) })

    // Sending it again goes to whoever is asked for, and does not issue it twice.
    emails.clearSentEmails()
    await run('invoice.email', owner(), { id: invoice.id, to: 'someone.else@example.test' })
    expect(emails.sentEmails()[0]).toMatchObject({ to: 'someone.else@example.test' })
    const events = await mod.withTenant(ORG_A, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from events where type = 'invoice.sent' and data->>'id' = ${invoice.id}`),
    )
    expect(events.rows[0]!.n).toBe(1)
  })

  it('refuses when there is nobody to send it to, and will not email a draft', async () => {
    const invoice = await draft({ companyId: await company() })
    await expect(run('invoice.email', owner(), { id: invoice.id })).rejects.toMatchObject({ code: 'invoice_not_sent' })
    await run('invoice.send', owner(), { id: invoice.id })
    await expect(run('invoice.email', owner(), { id: invoice.id })).rejects.toMatchObject({ code: 'no_email_address' })
  })
})

describe('the printed invoice', () => {
  it('shows the organization, the client, the lines, and how to pay', async () => {
    const companyId = await company()
    const invoice = await draft({ companyId, lines: [{ description: 'Design', quantity: '2', unitAmountMinor: 500_00, taxRateId: await taxRate('10') }] })
    const issued = await run('invoice.send', owner(), { id: invoice.id, issueDate: '2026-09-16' })

    const input = await mod.withTenant(ORG_A, async (tx) => {
      const ctx = registry.buildContext({ organizationId: ORG_A, actor: { type: 'user', id: ownerA, label: 'owner' }, role: 'owner', permissions: core.permissionsForRole('owner') }, tx)
      const { documentPdfInput } = await import('../src/modules/finance/pdf.ts')
      return documentPdfInput(ctx, issued, 'invoice')
    })
    expect(input).toMatchObject({
      kind: 'invoice',
      number: issued.number,
      marker: null,
      issuer: { name: 'Webloom Labs Pty Ltd', addressLines: ['1 Harbour St', 'Sydney NSW 2000'], taxNumber: 'ABN 12 345 678 901' },
      facts: [
        { label: 'Issued', value: '16/09/2026' },
        { label: 'Due', value: '07/10/2026' },
      ],
      paymentInstructions: 'Transfer to BSB 000-000, account 1234567.',
    })
    expect(input.lines).toEqual([{ description: 'Design', quantity: '2', unitAmount: '$500.00', discount: null, tax: expect.stringContaining('10%'), amount: '$1,000.00' }])
    expect(input.totals).toMatchObject({ subtotal: '$1,000.00', total: '$1,100.00', taxes: [{ amount: '$100.00', label: expect.stringContaining('10%') }] })

    const bytes = await pdf.renderDocumentPdf(input)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('marks a draft as a draft and a cancelled invoice as cancelled', async () => {
    const { documentPdfInput } = await import('../src/modules/finance/pdf.ts')
    const invoice = await draft()
    const marker = async (document: any) =>
      mod.withTenant(ORG_A, async (tx) =>
        (
          await documentPdfInput(
            registry.buildContext({ organizationId: ORG_A, actor: { type: 'user', id: ownerA, label: 'owner' }, role: 'owner', permissions: core.permissionsForRole('owner') }, tx),
            document,
            'invoice',
          )
        ).marker,
      )
    expect(await marker(invoice)).toBe('DRAFT')
    await run('invoice.send', owner(), { id: invoice.id })
    expect(await marker(await run('invoice.cancel', owner(), { id: invoice.id }))).toBe('CANCELLED')
  })
})

describe('who may bill', () => {
  it('keeps invoices away from developers', async () => {
    const invoice = await draft()
    await expect(run('invoice.get', developer(), { id: invoice.id })).rejects.toBeInstanceOf(core.ForbiddenError)
    await expect(run('invoice.create', developer(), { companyId: invoice.companyId, title: 'Nope' })).rejects.toBeInstanceOf(core.ForbiddenError)
  })
})
