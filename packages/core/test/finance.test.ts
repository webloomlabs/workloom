import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'
import { captureError } from '@workloom/db/testing/errors'
import { GOLDEN_FIXTURES, type GoldenFixture } from '../src/tax/fixtures.ts'

/**
 * Quotes, tax rates, and services: the golden fixtures stored and read back,
 * gapless numbering under concurrency, sent quotes that cannot change even in
 * SQL, the client's answer and expiry, and exchange rates captured when sent.
 *
 * Generic guarantees (audit, events, cross-tenant 404s, permission refusal) are
 * covered for every procedure in procedures.test.ts.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let modules: typeof import('../src/modules/index.ts')

const ORG_A = '01a0a800-0000-7000-8000-00000000000a'
const ORG_C = '01a0a800-0000-7000-8000-00000000000c'
let ownerA: string
let ownerC: string
let accountManagerA: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  modules = await import('../src/modules/index.ts')

  ownerA = core.newId()
  ownerC = core.newId()
  accountManagerA = core.newId()

  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone) values
        (${ORG_A}::uuid, 'Org A', 'finance-a', 'AUD', 'Australia/Sydney'),
        (${ORG_C}::uuid, 'Org C', 'finance-c', 'AUD', 'UTC')`)
    await db.execute(sql`
      insert into "user" (id, name, email) values
        (${ownerA}::uuid, 'Owner A', 'f-a@example.com'),
        (${ownerC}::uuid, 'Owner C', 'f-c@example.com'),
        (${accountManagerA}::uuid, 'Account Manager', 'f-am@example.com')`)
    await db.execute(sql`
      insert into member (id, organization_id, user_id, role) values
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${ownerA}::uuid, 'owner'),
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${accountManagerA}::uuid, 'accountManager'),
        (${core.newId()}::uuid, ${ORG_C}::uuid, ${ownerC}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

type Role = 'owner' | 'accountManager'
const as = (organizationId: string, userId: string, role: Role) => ({
  organizationId,
  actor: { type: 'user' as const, id: userId, label: role },
  role,
  permissions: core.permissionsForRole(role),
})
const owner = () => as(ORG_A, ownerA, 'owner')
const accountManager = () => as(ORG_A, accountManagerA, 'accountManager')

function run<T = any>(name: string, actor: ReturnType<typeof as>, input: unknown, now?: Date): Promise<T> {
  return registry.executeProcedure(name, { ...actor, input, ...(now ? { now } : {}) }) as Promise<T>
}

const unique = () => core.newId().slice(-8)
const company = async (actor = owner()) => (await run('company.create', actor, { name: `Client ${unique()}` })).id as string
const taxRate = async (rate = '10', actor = owner()) => (await run('taxRate.create', actor, { name: `Tax ${rate} ${unique()}`, rate })).id as string
const draft = async (input: Record<string, unknown> = {}, actor = owner()) =>
  run('quote.create', actor, { companyId: await company(actor), title: `Quote ${unique()}`, lines: [{ description: 'Design', unitAmountMinor: 1000_00 }], ...input })

describe('golden fixtures, stored and read back', () => {
  const rates = new Map<string, string>()
  const rateId = async (rate: string) => {
    if (!rates.has(rate)) rates.set(rate, await taxRate(rate))
    return rates.get(rate)!
  }
  const exchange: Record<string, string> = { AUD: '1', JPY: '0.0105', KWD: '4.9' }

  const expectMatches = (quote: any, expected: GoldenFixture['expected']) => {
    expect({ subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor, taxMinor: quote.taxMinor, totalMinor: quote.totalMinor }).toEqual({
      subtotalMinor: expected.subtotalMinor,
      discountMinor: expected.discountMinor,
      taxMinor: expected.taxMinor,
      totalMinor: expected.totalMinor,
    })
    expect(
      quote.lines.map((l: any) => ({ netMinor: l.netMinor, documentDiscountMinor: l.documentDiscountMinor, taxMinor: l.taxMinor, totalMinor: l.totalMinor })),
    ).toEqual(expected.lines)
    if (expected.taxes) expect(quote.taxes.map(({ rate, amountMinor, taxMinor }: any) => ({ rate, amountMinor, taxMinor }))).toEqual(expected.taxes)
  }

  it.each(GOLDEN_FIXTURES.map((f) => [f.name, f] as const))('%s', async (_, fixture) => {
    const { document } = fixture
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
    expectMatches(await run('quote.get', owner(), { id: created.id }), fixture.expected)

    // Stored as numbers the database can add up itself.
    const { rows } = await mod.withTenant(ORG_A, (tx) =>
      tx.execute<{ lines: string; total: string }>(sql`select coalesce(sum(l.total_minor), 0)::text as lines, q.total_minor::text as total
        from quotes q left join quote_lines l on l.quote_id = q.id where q.id = ${created.id}::uuid group by q.total_minor`),
    )
    expect(rows[0]!.lines).toBe(rows[0]!.total)

    if (document.lines.length === 0) return
    const sent = await run('quote.send', owner(), { id: created.id, exchangeRate: exchange[document.currency] })
    expectMatches(sent, fixture.expected)
    expectMatches(await run('quote.get', owner(), { id: created.id }), fixture.expected)
  })
})

describe('numbering', () => {
  const inOrgC = () => as(ORG_C, ownerC, 'owner')

  it('gives 20 quotes sent at once 20 distinct numbers, with no gaps', async () => {
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push((await draft({}, inOrgC())).id)
    // Two that will fail to send must not consume a number.
    const failing = [(await draft({ lines: [] }, inOrgC())).id, (await draft({ currency: 'USD' }, inOrgC())).id]

    const results = await Promise.allSettled([...ids, ...failing].map((id) => run('quote.send', inOrgC(), { id })))
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2)
    const numbers = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.number as string] : [])).sort()
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => `Q-${String(i + 1).padStart(4, '0')}`))

    expect((await run('quote.send', inOrgC(), { id: (await draft({}, inOrgC())).id })).number).toBe('Q-0021')
  })

  it('numbers drafts only when they are sent', async () => {
    expect((await draft()).number).toBeNull()
  })
})

describe('a sent quote', () => {
  it('cannot be edited, re-priced, or deleted through the application', async () => {
    const quote = await draft()
    const sent = await run('quote.send', owner(), { id: quote.id })
    const lineId = sent.lines[0].id

    await expect(run('quote.update', owner(), { id: quote.id, title: 'Changed' })).rejects.toMatchObject({ code: 'quote_not_draft' })
    await expect(run('quoteLine.add', owner(), { id: quote.id, description: 'Extra', unitAmountMinor: 1 })).rejects.toMatchObject({ code: 'quote_not_draft' })
    await expect(run('quoteLine.update', owner(), { id: lineId, quantity: '2' })).rejects.toMatchObject({ code: 'quote_not_draft' })
    await expect(run('quoteLine.remove', owner(), { id: lineId })).rejects.toMatchObject({ code: 'quote_not_draft' })
    await expect(run('quote.send', owner(), { id: quote.id })).rejects.toMatchObject({ code: 'quote_not_draft' })
    await expect(run('quote.delete', owner(), { id: quote.id })).rejects.toBeInstanceOf(core.ConflictError)
    expect(await run('quote.get', owner(), { id: quote.id })).toEqual(sent)
  })

  it('cannot be changed in SQL either, except to record the answer', async () => {
    const quote = await draft()
    const sent = await run('quote.send', owner(), { id: quote.id })
    const inA = (statement: ReturnType<typeof sql>) => mod.withTenant(ORG_A, (tx) => tx.execute(statement))

    expect(await captureError(() => inA(sql`update quotes set total_minor = 1 where id = ${quote.id}::uuid`))).toMatch(/can no longer change/)
    expect(await captureError(() => inA(sql`update quotes set status = 'draft', number = null, sent_at = null where id = ${quote.id}::uuid`))).toMatch(/can no longer change/)
    expect(await captureError(() => inA(sql`update quote_lines set unit_amount_minor = 1 where id = ${sent.lines[0].id}::uuid`))).toMatch(/only while the quote is a draft/)
    expect(await captureError(() => inA(sql`delete from quote_lines where id = ${sent.lines[0].id}::uuid`))).toMatch(/only while the quote is a draft/)
    expect(
      await captureError(() =>
        inA(sql`insert into quote_lines (id, organization_id, quote_id, position, description, quantity, unit_amount_minor, amount_minor, line_discount_minor, net_minor, document_discount_minor, tax_minor, total_minor)
          values (${core.newId()}::uuid, ${ORG_A}::uuid, ${quote.id}::uuid, 9, 'sneaked in', 1, 1, 1, 0, 1, 0, 0, 1)`),
      ),
    ).toMatch(/only while the quote is a draft/)
    expect(await captureError(() => inA(sql`delete from quotes where id = ${quote.id}::uuid`))).toMatch(/never deleted/)

    // Recording the client's answer is allowed.
    await inA(sql`update quotes set status = 'accepted', accepted_at = now() where id = ${quote.id}::uuid`)
    expect((await run('quote.get', owner(), { id: quote.id })).status).toBe('accepted')
  })

  it('can be duplicated into a new draft with the same lines and totals', async () => {
    const sent = await run('quote.send', owner(), { id: (await draft({ discountPercent: '10' })).id })
    const copy = await run('quote.duplicate', owner(), { id: sent.id })
    expect(copy).toMatchObject({ status: 'draft', number: null, totalMinor: sent.totalMinor, discountPercent: '10', title: sent.title })
    expect(copy.lines.map((l: any) => l.description)).toEqual(sent.lines.map((l: any) => l.description))
    expect(copy.id).not.toBe(sent.id)
  })
})

describe("the client's answer", () => {
  it('is recorded once, on a sent quote that has not expired', async () => {
    await expect(run('quote.accept', owner(), { id: (await draft()).id })).rejects.toMatchObject({ code: 'quote_not_sent' })

    const accepted = await run('quote.send', owner(), { id: (await draft()).id })
    expect(await run('quote.accept', owner(), { id: accepted.id })).toMatchObject({ status: 'accepted', acceptedAt: expect.any(Date) })
    await expect(run('quote.decline', owner(), { id: accepted.id })).rejects.toMatchObject({ code: 'quote_not_sent' })

    const declined = await run('quote.send', owner(), { id: (await draft()).id })
    expect(await run('quote.decline', owner(), { id: declined.id, reason: 'Too expensive' })).toMatchObject({ status: 'declined', declineReason: 'Too expensive' })
  })

  it('is refused after the valid-until date, and the worker marks the quote expired', async () => {
    const quote = await draft({ validUntil: '2026-10-01' })
    await run('quote.send', owner(), { id: quote.id, issueDate: '2026-09-15' }, new Date('2026-09-15T00:00:00Z'))
    // 2 October in Sydney.
    const later = new Date('2026-10-01T14:30:00Z')
    await expect(run('quote.accept', owner(), { id: quote.id }, later)).rejects.toMatchObject({ code: 'quote_expired' })

    const expired = await mod.withTenant(ORG_A, (tx) =>
      modules.expireDueQuotes(registry.buildContext({ organizationId: ORG_A, actor: { type: 'job', label: 'quote expiry' }, role: null, permissions: new Set(), now: later }, tx)),
    )
    expect(expired).toBeGreaterThanOrEqual(1)
    expect(await run('quote.get', owner(), { id: quote.id })).toMatchObject({ status: 'expired', expiredAt: later })
    const { rows } = await mod.withTenant(ORG_A, (tx) =>
      tx.execute<{ type: string }>(sql`select type from events where type = 'quote.expired' and data->>'id' = ${quote.id}`),
    )
    expect(rows).toHaveLength(1)
  })

  it('cannot be sent already expired', async () => {
    const quote = await draft({ validUntil: '2026-01-01' })
    await expect(run('quote.send', owner(), { id: quote.id, issueDate: '2026-02-01' })).rejects.toMatchObject({ code: 'valid_until_passed' })
  })
})

describe('currencies', () => {
  it('capture the exchange rate and base total when sent, and keep them', async () => {
    const usd = await draft({ currency: 'USD', lines: [{ description: 'Build', unitAmountMinor: 1234_57 }] })
    await expect(run('quote.send', owner(), { id: usd.id })).rejects.toMatchObject({ code: 'exchange_rate_required', field: 'exchangeRate' })
    await expect(run('quote.send', owner(), { id: usd.id, exchangeRate: '0' })).rejects.toThrow()

    const sent = await run('quote.send', owner(), { id: usd.id, exchangeRate: '1.52345678' })
    // 1234.57 × 1.52345678 = 1880.8140... AUD
    expect(sent).toMatchObject({ baseCurrency: 'AUD', exchangeRateToBase: '1.52345678', totalBaseMinor: 1880_81 })

    await run('organization.update', owner(), { baseCurrency: 'NZD' })
    expect(await run('quote.get', owner(), { id: usd.id })).toMatchObject({ baseCurrency: 'AUD', totalBaseMinor: 1880_81 })
    await run('organization.update', owner(), { baseCurrency: 'AUD' })
  })

  it('fix a draft currency once lines are priced in it', async () => {
    const quote = await draft()
    await expect(run('quote.update', owner(), { id: quote.id, currency: 'USD' })).rejects.toMatchObject({ code: 'currency_locked' })
    const empty = await draft({ lines: [] })
    expect(await run('quote.update', owner(), { id: empty.id, currency: 'USD' })).toMatchObject({ currency: 'USD' })
  })

  it('come from the deal when a quote starts from one', async () => {
    const companyId = await company()
    const deal = await run('deal.create', owner(), { companyId, name: 'Retainer', valueMinor: 1, currency: 'EUR' })
    expect(await run('quote.create', owner(), { dealId: deal.id, title: 'From the deal' })).toMatchObject({ companyId, dealId: deal.id, currency: 'EUR' })
  })
})

describe('drafts', () => {
  it('re-price after every change', async () => {
    const gst = await taxRate('10')
    const quote = await draft({ lines: [{ description: 'Design', quantity: '2', unitAmountMinor: 500_00, taxRateId: gst }] })
    expect(quote).toMatchObject({ subtotalMinor: 1000_00, taxMinor: 100_00, totalMinor: 1100_00 })

    const edited = await run('quoteLine.update', owner(), { id: quote.lines[0].id, quantity: '3.5' })
    expect(edited).toMatchObject({ subtotalMinor: 1750_00, taxMinor: 175_00, totalMinor: 1925_00 })
    const discounted = await run('quote.update', owner(), { id: quote.id, discountAmountMinor: 750_00 })
    expect(discounted).toMatchObject({ discountMinor: 750_00, taxMinor: 100_00, totalMinor: 1100_00 })
    // A percentage replaces the amount.
    expect(await run('quote.update', owner(), { id: quote.id, discountPercent: '10' })).toMatchObject({ discountAmountMinor: null, discountPercent: '10', discountMinor: 175_00 })
    const inclusive = await run('quote.update', owner(), { id: quote.id, taxMode: 'inclusive', discountPercent: null })
    expect(inclusive).toMatchObject({ subtotalMinor: 1750_00, taxMinor: 159_09, totalMinor: 1750_00 })

    const added = await run('quoteLine.add', owner(), { id: quote.id, description: 'Credit', quantity: -1, unitAmountMinor: 250_00 })
    expect(added.lines.map((l: any) => l.position)).toEqual([1, 2])
    const removed = await run('quoteLine.remove', owner(), { id: added.lines[1].id })
    expect(removed.totalMinor).toBe(inclusive.totalMinor)
  })

  it('refuse a discount the calculator cannot apply, naming the field', async () => {
    const quote = await draft()
    await expect(run('quote.update', owner(), { id: quote.id, discountAmountMinor: 1000_01 })).rejects.toMatchObject({ code: 'discount_exceeds_subtotal', field: 'discount' })
    await expect(run('quote.update', owner(), { id: quote.id, discountPercent: '5', discountAmountMinor: 1 })).rejects.toMatchObject({ code: 'one_discount' })
    await expect(draft({ lines: [{ description: 'x', quantity: '0', unitAmountMinor: 1 }] })).rejects.toThrow()
  })

  it('link only to the client\'s own contact, deal, and project', async () => {
    const [mine, theirs] = [await company(), await company()]
    const contact = await run('contact.create', owner(), { firstName: 'Ada', companyId: theirs })
    const deal = await run('deal.create', owner(), { companyId: theirs, name: 'Other deal', valueMinor: 1 })
    const project = await run('project.create', owner(), { name: 'Other project', companyId: theirs })
    const base = { companyId: mine, title: 'Mismatch' }
    await expect(run('quote.create', owner(), { ...base, contactId: contact.id })).rejects.toMatchObject({ code: 'contact_company_mismatch' })
    await expect(run('quote.create', owner(), { ...base, dealId: deal.id })).rejects.toMatchObject({ code: 'deal_company_mismatch' })
    await expect(run('quote.create', owner(), { ...base, projectId: project.id })).rejects.toMatchObject({ code: 'project_company_mismatch' })
    await expect(run('quote.create', owner(), { title: 'Nobody' })).rejects.toMatchObject({ code: 'company_required' })
  })
})

describe('services and tax rates', () => {
  it('fill a line from the catalogue, in the quote\'s currency', async () => {
    const gst = await taxRate('10')
    const service = await run('service.create', owner(), { name: `Hosting ${unique()}`, defaultPriceMinor: 50_00, defaultTaxRateId: gst, unit: 'month' })
    const quote = await draft({ lines: [{ serviceId: service.id, quantity: '12' }] })
    expect(quote.lines[0]).toMatchObject({ description: service.name, unitAmountMinor: 50_00, taxRateId: gst, taxRate: '10', serviceId: service.id })
    expect(quote.totalMinor).toBe(660_00)

    // No price in another currency, and no tax when asked for none.
    await expect(draft({ currency: 'USD', lines: [{ serviceId: service.id }] })).rejects.toMatchObject({ code: 'unit_amount_required' })
    const usd = await draft({ currency: 'USD', lines: [{ serviceId: service.id, unitAmountMinor: 40_00, taxRateId: null }] })
    expect(usd.lines[0]).toMatchObject({ unitAmountMinor: 40_00, taxRateId: null })

    await run('service.archive', owner(), { id: service.id })
    await expect(draft({ lines: [{ serviceId: service.id }] })).rejects.toMatchObject({ code: 'archived' })
  })

  it('keep their rate once a document uses it, and lines keep what they were given', async () => {
    const rate = await taxRate('10')
    expect(await run('taxRate.update', owner(), { id: rate, rate: '12.5' })).toMatchObject({ rate: '12.5' })
    const quote = await draft({ lines: [{ description: 'Design', unitAmountMinor: 100_00, taxRateId: rate }] })

    await expect(run('taxRate.update', owner(), { id: rate, rate: '15' })).rejects.toMatchObject({ code: 'tax_rate_in_use' })
    await run('taxRate.update', owner(), { id: rate, name: `Renamed ${unique()}` })
    await run('taxRate.archive', owner(), { id: rate })

    const reread = await run('quote.get', owner(), { id: quote.id })
    expect(reread.lines[0]).toMatchObject({ taxRate: '12.5', taxName: quote.lines[0].taxName })
    await expect(run('quoteLine.add', owner(), { id: quote.id, description: 'More', unitAmountMinor: 1, taxRateId: rate })).rejects.toMatchObject({ code: 'archived' })
  })

  it('refuse duplicate names among live records', async () => {
    const name = `VAT ${unique()}`
    await run('taxRate.create', owner(), { name, rate: '20' })
    await expect(run('taxRate.create', owner(), { name: name.toUpperCase(), rate: '5' })).rejects.toMatchObject({ code: 'duplicate_name' })
  })

  it('are readable by account managers, who quote, but only finance and owners configure tax', async () => {
    expect((await run('taxRate.list', accountManager(), {})).data.length).toBeGreaterThan(0)
    await expect(run('taxRate.create', accountManager(), { name: 'Nope', rate: '1' })).rejects.toBeInstanceOf(core.ForbiddenError)
    const quote = await draft({}, accountManager())
    expect((await run('quote.send', accountManager(), { id: quote.id })).status).toBe('sent')
  })
})

describe('the client view', () => {
  it('counts a company\'s quotes', async () => {
    const quote = await draft()
    const summary = await run('company.summary', owner(), { id: quote.companyId })
    expect(summary.sections.find((s: any) => s.key === 'quotes')).toMatchObject({ status: 'available', count: 1 })
  })
})
