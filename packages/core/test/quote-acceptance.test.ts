import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Quotes carried into the work (S18): alternatives of which the client takes
 * one, a first quote that sets the project's price and later ones that add to
 * it, recurring lines that become paused schedules, and a billing plan whose
 * last stage is a statement of the whole project -- the agency's own final
 * invoice, produced without anyone typing it.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let modules: typeof import('../src/modules/index.ts')
let emails: typeof import('@workloom/emails')

const ORG = '01a0dd00-0000-7000-8000-0000000018aa'
let owner: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  modules = await import('../src/modules/index.ts')
  emails = await import('@workloom/emails')
  owner = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`insert into organization (id, name, slug, base_currency, timezone, legal_name) values (${ORG}::uuid, 'Webloom', 'webloom-s18', 'LKR', 'Asia/Colombo', 'Webloom Labs (Pvt) Ltd')`)
    await db.execute(sql`insert into "user" (id, name, email) values (${owner}::uuid, 'Owner', 's18-owner@example.com')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role) values (${core.newId()}::uuid, ${ORG}::uuid, ${owner}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

const actor = () => ({ organizationId: ORG, actor: { type: 'user' as const, id: owner, label: 'owner' }, role: 'owner' as const, permissions: core.permissionsForRole('owner') })
function run<T = any>(name: string, input: unknown): Promise<T> {
  return registry.executeProcedure(name, { ...actor(), input }) as Promise<T>
}
async function refused(name: string, input: unknown, code: string) {
  await expect(run(name, input)).rejects.toMatchObject({ code })
}
const unique = () => core.newId().slice(-8)
const company = async () => (await run('company.create', { name: `Client ${unique()}`, email: `client-${unique()}@example.com` })).id as string
async function sentQuote(companyId: string, title: string, lines: unknown[], extra: Record<string, unknown> = {}) {
  const quote = await run('quote.create', { companyId, title, lines, validUntil: '2099-12-31', ...extra })
  return run('quote.send', { id: quote.id })
}

describe('alternatives', () => {
  it('take one: accepting an option declines the others still open', async () => {
    const companyId = await company()
    const essentials = await sentQuote(companyId, 'Essentials', [{ description: 'Store', unitAmountMinor: 50_000_00 }])
    const standard = await run('quote.duplicate', { id: essentials.id, asOption: true, optionLabel: 'Option B — Standard' })
    expect(standard.optionGroupId).not.toBeNull()
    expect((await run('quote.get', { id: essentials.id })).optionLabel).toBe('Option A')
    await run('quote.send', { id: standard.id })
    const premium = await run('quote.duplicate', { id: essentials.id, asOption: true, optionLabel: 'Option C — Premium' })
    expect(premium.optionGroupId).toBe(standard.optionGroupId)

    const accepted = await run('quote.accept', { id: standard.id })
    expect(accepted.status).toBe('accepted')
    expect(accepted.applied.declinedQuoteIds).toEqual([essentials.id])
    expect((await run('quote.get', { id: essentials.id })).declineReason).toBe('Another option was chosen.')
    // A draft option is left alone -- but it can no longer be offered.
    expect((await run('quote.get', { id: premium.id })).status).toBe('draft')
    await refused('quote.send', { id: premium.id }, 'option_group_decided')
  })

  it('can never have two accepted, even accepted at the same moment', async () => {
    const companyId = await company()
    const a = await run('quote.create', { companyId, title: 'A', validUntil: '2099-12-31', lines: [{ description: 'A', unitAmountMinor: 1_00 }] })
    const b = await run('quote.create', { companyId, title: 'B', validUntil: '2099-12-31', lines: [{ description: 'B', unitAmountMinor: 2_00 }] })
    await run('quoteOptionGroup.create', { companyId, name: 'Pick one', quotes: [{ id: a.id }, { id: b.id }] })
    await run('quote.send', { id: a.id })
    await run('quote.send', { id: b.id })
    const results = await Promise.allSettled([run('quote.accept', { id: a.id }), run('quote.accept', { id: b.id })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const statuses = [(await run('quote.get', { id: a.id })).status, (await run('quote.get', { id: b.id })).status].sort()
    expect(statuses).toEqual(['accepted', 'declined'])
  })

  it("belong to one client's group, at the database", async () => {
    const group = await run('quoteOptionGroup.create', { companyId: await company(), name: 'Mine' })
    const other = await run('quote.create', { companyId: await company(), title: 'Theirs', lines: [{ description: 'X', unitAmountMinor: 1_00 }] })
    const error = await mod
      .withTenant(ORG, (tx) => tx.execute(sql`update quotes set option_group_id = ${group.id}::uuid where id = ${other.id}::uuid`))
      .then(() => null, (e: any) => `${e.message} ${e.cause?.message ?? ''}`)
    expect(error).toMatch(/its own client/)
  })
})

describe('the Kyla & Co. project, from quote to final invoice', () => {
  it('carries the quote into a project, adds scope as revisions, and bills the balance as a statement', async () => {
    const companyId = await company()
    // The quote: the store, and hosting every month.
    const quote = await sentQuote(companyId, 'Kyla & Co. store development', [
      { description: 'Kyla & Co. store development', unitAmountMinor: 65_000_00, billingType: 'one_off' },
      { description: 'Hosting and care', unitAmountMinor: 3_000_00, billingType: 'recurring', intervalUnit: 'month', intervalCount: 1 },
    ])
    expect(quote.split).toEqual({ oneTimeNetMinor: 65_000_00, oneTimeTotalMinor: 65_000_00, recurring: [{ unit: 'month', count: 1, perPeriodNetMinor: 3_000_00 }] })

    const accepted = await run('quote.accept', {
      id: quote.id,
      createProject: { name: 'Kyla & Co. store', startDate: '2026-08-01' },
      stagePreset: 'deposit_balance',
      depositAmountMinor: 26_000_00,
    })
    const projectId = accepted.applied.projectId
    expect(accepted.applied).toMatchObject({ contract: 'base', revisionId: null })
    expect(accepted.applied.scheduleIds).toHaveLength(1)
    expect(accepted.applied.stageIds).toHaveLength(2)
    expect(await run('project.get', { id: projectId })).toMatchObject({ contractValueMinor: 65_000_00, billingModel: 'fixed_price', companyId })
    expect((await run('quote.get', { id: quote.id })).projectId).toBe(projectId)
    // Hosting waits for launch.
    const schedule = await run('billingSchedule.get', { id: accepted.applied.scheduleIds[0] })
    expect(schedule).toMatchObject({ status: 'paused', currency: 'LKR', projectId, periodSubtotalMinor: 3_000_00 })

    // Four more pieces of scope, each its own quote, each added as a revision.
    for (const [title, amount] of [
      ['Gift vouchers and store credits', 5_000_00],
      ['Meta Pixel & CAPI setup', 3_000_00],
      ['Business email setup', 2_000_00],
      ['Additional product adjustments', 5_000_00],
    ] as const) {
      const extra = await sentQuote(companyId, title, [{ description: title, unitAmountMinor: amount, billingType: 'one_off' }], { projectId })
      const added = await run('quote.accept', { id: extra.id })
      expect(added.applied.contract).toBe('revision')
    }
    const summary = await run('project.billingSummary', { id: projectId })
    expect(summary.contractedValueMinor).toBe(80_000_00)

    // The plan: a 26,000 deposit, and the balance -- 54,000 now -- as a statement.
    const plan = await run('projectBillingStage.list', { id: projectId })
    expect(plan.stages.map((s: any) => [s.name, s.basis, s.resolvedAmountMinor, s.invoiceStyle])).toEqual([
      ['Deposit', 'amount', 26_000_00, 'single_line'],
      ['Balance at launch', 'balance', 54_000_00, 'statement'],
    ])
    const [deposit, balance] = plan.stages

    // The final invoice cannot go out while the deposit is still a draft.
    const depositRelease = await run('projectBillingStage.release', { id: deposit.id })
    await refused('projectBillingStage.release', { id: balance.id }, 'earlier_stage_draft')
    const depositInvoice = await run('invoice.send', { id: depositRelease.invoiceId, issueDate: '2026-08-02' })
    await run('payment.record', { companyId, amountMinor: 26_000_00, receivedOn: '2026-08-05', allocations: [{ invoiceId: depositInvoice.id }] })

    const final = await run('projectBillingStage.release', { id: balance.id, dueLabel: 'At launch' })
    const invoice = await run('invoice.get', { id: final.invoiceId })
    expect(invoice.lines.filter((l: any) => l.kind === 'item').map((l: any) => [l.description, l.detail, l.netMinor])).toEqual([
      ['Kyla & Co. store development', 'Initially quoted project fee', 65_000_00],
      ['Gift vouchers and store credits', 'Additional scope', 5_000_00],
      ['Meta Pixel & CAPI setup', 'Additional scope', 3_000_00],
      ['Business email setup', 'Additional scope', 2_000_00],
      ['Additional product adjustments', 'Additional scope', 5_000_00],
    ])
    expect(invoice.totals).toMatchObject({ statement: true, itemsTotalMinor: 80_000_00, balanceDueMinor: 54_000_00, receivedMinor: 26_000_00 })
    expect(invoice.dueLabel).toBe('At launch')
    const after = await run('project.billingSummary', { id: projectId })
    expect(after.remainingMinor).toBe(0)
    expect(after.otherInvoicedMinor).toBe(0)
  })

  it('refuses a statement that would not be the last word, or would not add up', async () => {
    const project = await run('project.create', { companyId: await company(), name: `Plan ${unique()}`, contractValueMinor: 10_000_00 })
    const statementFirst = await run('projectBillingStage.create', { id: project.id, name: 'Statement', basis: 'amount', amountMinor: 4_000_00, invoiceStyle: 'statement' })
    await run('projectBillingStage.create', { id: project.id, name: 'Later', basis: 'balance' })
    await refused('projectBillingStage.release', { id: statementFirst.id }, 'statement_not_last')
    await refused('projectBillingStage.create', { id: project.id, name: 'Second balance', basis: 'balance' }, 'balance_exists')
  })
})

describe('quotes and projects', () => {
  it('set the contract once, and refuse a second base', async () => {
    const companyId = await company()
    const project = await run('project.create', { companyId, name: `Build ${unique()}` })
    const first = await sentQuote(companyId, 'Build', [{ description: 'Build', unitAmountMinor: 10_000_00 }])
    await run('quote.accept', { id: first.id, projectId: project.id })
    expect((await run('project.get', { id: project.id })).contractValueMinor).toBe(10_000_00)
    const second = await sentQuote(companyId, 'Also build', [{ description: 'More', unitAmountMinor: 1_00 }], { projectId: project.id })
    await refused('quote.accept', { id: second.id, applyAs: 'base' }, 'contract_exists')
  })

  it("accept the revision already drafted for a quote, so nothing counts twice", async () => {
    const companyId = await company()
    const project = await run('project.create', { companyId, name: `Rev ${unique()}`, contractValueMinor: 10_000_00 })
    const quote = await sentQuote(companyId, 'Extra page', [{ description: 'Page', unitAmountMinor: 2_000_00 }], { projectId: project.id })
    const revision = await run('projectRevision.create', { id: project.id, title: 'Extra page', amountMinor: 2_000_00, quoteId: quote.id })
    const accepted = await run('quote.accept', { id: quote.id })
    expect(accepted.applied.revisionId).toBe(revision.id)
    expect((await run('project.billingSummary', { id: project.id })).contractedValueMinor).toBe(12_000_00)
  })

  it("refuse a project of another client", async () => {
    const quote = await sentQuote(await company(), 'Q', [{ description: 'X', unitAmountMinor: 1_00 }])
    const other = await run('project.create', { companyId: await company(), name: 'Theirs' })
    await refused('quote.accept', { id: quote.id, projectId: other.id }, 'project_company_mismatch')
  })

  it('can be linked to their project once after sending, and never moved, at the database', async () => {
    const companyId = await company()
    const quote = await sentQuote(companyId, 'Q', [{ description: 'X', unitAmountMinor: 1_00 }])
    const a = await run('project.create', { companyId, name: 'A' })
    const b = await run('project.create', { companyId, name: 'B' })
    await mod.withTenant(ORG, (tx) => tx.execute(sql`update quotes set project_id = ${a.id}::uuid where id = ${quote.id}::uuid`))
    const moved = await mod
      .withTenant(ORG, (tx) => tx.execute(sql`update quotes set project_id = ${b.id}::uuid where id = ${quote.id}::uuid`))
      .then(() => null, (e: any) => `${e.message} ${e.cause?.message ?? ''}`)
    expect(moved).toMatch(/can no longer change/)
  })
})

describe('invoicing a quote directly', () => {
  it('needs it accepted, bills its one-time lines once, and never a declined option', async () => {
    const companyId = await company()
    const quote = await sentQuote(companyId, 'Simple', [
      { description: 'Logo', unitAmountMinor: 15_000_00 },
      { description: 'Social', unitAmountMinor: 20_000_00, billingType: 'recurring', intervalUnit: 'month', intervalCount: 1 },
    ])
    await refused('invoice.fromQuote', { id: quote.id }, 'quote_not_accepted')
    await run('quote.accept', { id: quote.id })
    const invoice = await run('invoice.fromQuote', { id: quote.id })
    expect(invoice.lines.map((l: any) => l.description)).toEqual(['Logo'])
    await refused('invoice.fromQuote', { id: quote.id }, 'quote_already_invoiced')
  })
})

describe('the printed quote', () => {
  it('can be downloaded and emailed with its PDF', async () => {
    emails.clearSentEmails()
    const quote = await sentQuote(await company(), 'Website', [{ description: 'Website', detail: 'Ten pages', unitAmountMinor: 65_000_00, billingType: 'one_off' }])
    const link = await run('quote.download', { id: quote.id })
    expect(link.url).toContain('/api/documents/')
    const token = link.url.split('/api/documents/')[1]
    expect(modules.readPdfToken(token)).toMatchObject({ kind: 'quote', documentId: quote.id })
    const rendered = await modules.renderQuotePdf(ORG, quote.id)
    expect(rendered!.bytes.subarray(0, 5).toString()).toBe('%PDF-')

    await run('quote.email', { id: quote.id })
    const sent = emails.sentEmails().at(-1)!
    expect(sent.subject).toContain(quote.number)
    expect(sent.attachments?.[0]?.contentType).toBe('application/pdf')
  })
})
