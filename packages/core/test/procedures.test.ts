import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Procedure-level guarantees, run against every registered procedure.
 *
 *   1. Every mutation writes at least one audit entry.
 *   2. No procedure lets one organization reach another's records.
 *   3. Every procedure refuses an actor lacking its permission.
 *
 * Coverage is enforced, not hoped for: the fixture table below must name every
 * mutation in the registry, so adding one without deciding how to exercise it
 * fails this file.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')

const ORG_A = '01a0a400-0000-7000-8000-00000000000a'
const ORG_B = '01a0a400-0000-7000-8000-00000000000b'
let ownerA: string
let ownerB: string
let developerA: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  await import('../src/modules/index.ts')

  ownerA = core.newId()
  ownerB = core.newId()
  developerA = core.newId()

  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug) values
        (${ORG_A}::uuid, 'Org A', 'org-a'), (${ORG_B}::uuid, 'Org B', 'org-b')`)
    await db.execute(sql`
      insert into "user" (id, name, email) values
        (${ownerA}::uuid, 'Owner A', 'a@example.com'),
        (${ownerB}::uuid, 'Owner B', 'b@example.com'),
        (${developerA}::uuid, 'Dev A', 'dev-a@example.com')`)
    await db.execute(sql`
      insert into member (id, organization_id, user_id, role) values
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${ownerA}::uuid, 'owner'),
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${developerA}::uuid, 'developer'),
        (${core.newId()}::uuid, ${ORG_B}::uuid, ${ownerB}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

function asOwner(organizationId: string, userId: string) {
  return {
    organizationId,
    actor: { type: 'user' as const, id: userId, label: 'owner' },
    role: 'owner' as const,
    permissions: core.permissionsForRole('owner'),
  }
}

function run(name: string, actor: ReturnType<typeof asOwner>, input: unknown) {
  return registry.executeProcedure(name, { ...actor, input })
}

async function auditCount(organizationId: string): Promise<number> {
  const { rows } = await mod.withTenant(organizationId, (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_logs`),
  )
  return rows[0]!.n
}

/**
 * A public IP literal: passes URL validation without the test needing network
 * access for DNS. Nothing is ever delivered in this file.
 */
const PUBLIC_HOOK_URL = 'https://93.184.215.14/hook'

async function createHook(organizationId = ORG_A, userId = ownerA): Promise<string> {
  const created = (await run('webhook.create', asOwner(organizationId, userId), {
    url: PUBLIC_HOOK_URL,
    eventTypes: ['*'],
  })) as { endpoint: { id: string } }
  return created.endpoint.id
}

const unique = () => core.newId().slice(-8)
const ownerOfA = () => asOwner(ORG_A, ownerA)

async function createCompany(input: Record<string, unknown> = {}): Promise<string> {
  const company = (await run('company.create', ownerOfA(), { name: `Company ${unique()}`, ...input })) as { id: string }
  return company.id
}

async function createContact(input: Record<string, unknown> = {}): Promise<string> {
  const contact = (await run('contact.create', ownerOfA(), {
    firstName: 'Ada',
    email: `ada-${unique()}@example.com`,
    ...input,
  })) as { id: string }
  return contact.id
}

async function createLead(input: Record<string, unknown> = {}): Promise<string> {
  const lead = (await run('lead.create', ownerOfA(), {
    contactName: 'Grace Hopper',
    companyName: `Lead Co ${unique()}`,
    email: `grace-${unique()}@example.com`,
    ...input,
  })) as { id: string }
  return lead.id
}

async function createDeal(input: Record<string, unknown> = {}): Promise<string> {
  const deal = (await run('deal.create', ownerOfA(), {
    companyId: await createCompany(),
    name: `Deal ${unique()}`,
    valueMinor: 500_000,
    ...input,
  })) as { id: string }
  return deal.id
}

async function createProject(input: Record<string, unknown> = {}): Promise<string> {
  const project = (await run('project.create', ownerOfA(), { name: `Project ${unique()}`, ...input })) as { id: string }
  return project.id
}

async function createTask(input: Record<string, unknown> = {}): Promise<{ id: string; projectId: string }> {
  const projectId = (input.projectId as string | undefined) ?? (await createProject())
  const task = (await run('task.create', ownerOfA(), { projectId, title: `Task ${unique()}`, ...input })) as { id: string }
  return { id: task.id, projectId }
}

async function createMilestone(input: Record<string, unknown> = {}): Promise<string> {
  const milestone = (await run('milestone.create', ownerOfA(), { id: await createProject(), name: `Milestone ${unique()}`, ...input })) as { id: string }
  return milestone.id
}

async function createEntry(): Promise<string> {
  const entry = (await run('timeEntry.create', ownerOfA(), { projectId: await createProject(), durationSeconds: 3600 })) as { id: string }
  return entry.id
}

async function stopTimer(): Promise<void> {
  await run('timer.stop', ownerOfA(), {}).catch(() => undefined)
}

async function createTaxRate(): Promise<string> {
  const taxRate = (await run('taxRate.create', ownerOfA(), { name: `Tax ${unique()}`, rate: '10' })) as { id: string }
  return taxRate.id
}

async function createService(): Promise<string> {
  const service = (await run('service.create', ownerOfA(), { name: `Service ${unique()}`, defaultPriceMinor: 100_00, defaultTaxRateId: await createTaxRate() })) as { id: string }
  return service.id
}

async function createQuote(): Promise<string> {
  const quote = (await run('quote.create', ownerOfA(), {
    companyId: await createCompany(),
    title: `Quote ${unique()}`,
    lines: [{ description: 'Discovery workshop', unitAmountMinor: 2_000_00 }],
  })) as { id: string }
  return quote.id
}

async function sentQuote(): Promise<string> {
  const id = await createQuote()
  await run('quote.send', ownerOfA(), { id })
  return id
}

async function createInvoice(): Promise<string> {
  const invoice = (await run('invoice.create', ownerOfA(), {
    companyId: await createCompany(),
    title: `Invoice ${unique()}`,
    lines: [{ description: 'Discovery workshop', unitAmountMinor: 2_000_00 }],
  })) as { id: string }
  return invoice.id
}

async function sentInvoice(): Promise<string> {
  const id = await createInvoice()
  await run('invoice.send', ownerOfA(), { id })
  return id
}

type IssuedInvoice = { id: string; companyId: string; totalMinor: number }

/**
 * An issued invoice. `overdue: true` dates it into the past, which is the only
 * way to exercise an invoice going late without waiting a fortnight.
 */
async function issuedInvoice(options: { overdue?: boolean } = {}): Promise<IssuedInvoice> {
  const invoice = (await run('invoice.create', ownerOfA(), {
    companyId: await createCompany(),
    title: `Invoice ${unique()}`,
    paymentTermsDays: options.overdue ? 0 : 30,
    lines: [{ description: 'Discovery workshop', unitAmountMinor: 2_000_00 }],
  })) as IssuedInvoice
  const sent = (await run('invoice.send', ownerOfA(), {
    id: invoice.id,
    ...(options.overdue ? { issueDate: '2020-01-01' } : {}),
  })) as IssuedInvoice
  return { id: invoice.id, companyId: sent.companyId, totalMinor: sent.totalMinor }
}

/** Money received from that invoice's client, allocated or waiting on account. */
async function pay(
  invoice: IssuedInvoice,
  options: { amountMinor?: number; allocate?: number | false; kind?: 'payment' | 'refund' } = {},
): Promise<{ id: string; allocations: Array<{ id: string }> }> {
  const amountMinor = options.amountMinor ?? invoice.totalMinor
  return (await run('payment.record', ownerOfA(), {
    companyId: invoice.companyId,
    kind: options.kind ?? 'payment',
    amountMinor,
    allocations: options.allocate === false ? [] : [{ invoiceId: invoice.id, amountMinor: options.allocate ?? amountMinor }],
  })) as { id: string; allocations: Array<{ id: string }> }
}

async function createPayment(input: Record<string, unknown> = {}): Promise<string> {
  const payment = (await run('payment.record', ownerOfA(), {
    companyId: await createCompany(),
    amountMinor: 500_00,
    ...input,
  })) as { id: string }
  return payment.id
}

async function createExpense(input: Record<string, unknown> = {}): Promise<string> {
  const expense = (await run('expense.create', ownerOfA(), {
    description: `Hosting ${unique()}`,
    amountMinor: 120_00,
    ...input,
  })) as { id: string }
  return expense.id
}

const aFile = () => new File([`hello ${unique()}`], 'notes.txt', { type: 'text/plain' })

async function archived(procedure: string, id: string): Promise<{ id: string }> {
  await run(procedure, ownerOfA(), { id })
  return { id }
}

async function createTicket(input: Record<string, unknown> = {}): Promise<string> {
  const ticket = (await run('ticket.create', ownerOfA(), {
    companyId: await createCompany(),
    title: `Ticket ${unique()}`,
    body: 'The contact form stopped sending.',
    ...input,
  })) as { id: string }
  return ticket.id
}

async function createPlan(input: Record<string, unknown> = {}): Promise<string> {
  const plan = (await run('maintenancePlan.create', ownerOfA(), {
    companyId: await createCompany(),
    name: `Care plan ${unique()}`,
    items: ['Security updates', 'Weekly backups'],
    ...input,
  })) as { id: string }
  return plan.id
}

async function createVisit(): Promise<string> {
  const visit = (await run('maintenanceVisit.create', ownerOfA(), {
    planId: await createPlan(),
    summary: `Applied updates ${unique()}`,
    kind: 'security_update',
  })) as { id: string }
  return visit.id
}

async function createAsset(input: Record<string, unknown> = {}): Promise<string> {
  const asset = (await run('infrastructureAsset.create', ownerOfA(), {
    name: `example-${unique()}.test`,
    kind: 'domain',
    provider: 'Registrar',
    expiresOn: '2030-01-31',
    ...input,
  })) as { id: string }
  return asset.id
}

async function createBankAccount(input: Record<string, unknown> = {}): Promise<string> {
  const account = (await run('bankAccount.create', ownerOfA(), {
    name: `Everyday ${unique()}`,
    kind: 'bank',
    openingBalanceOn: '2026-09-01',
    openingBalanceMinor: 10_000_00,
    ...input,
  })) as { id: string }
  return account.id
}

async function createBankTransaction(input: Record<string, unknown> = {}): Promise<string> {
  const line = (await run('bankTransaction.create', ownerOfA(), {
    bankAccountId: await createBankAccount(),
    amountMinor: 1_320_00,
    bookedOn: '2026-09-16',
    description: `TRANSFER ACME ${unique()}`,
    ...input,
  })) as { id: string }
  return line.id
}

async function createDocument(input: Record<string, unknown> = {}): Promise<string> {
  const document = (await run('document.upload', ownerOfA(), {
    companyId: await createCompany(),
    file: aFile(),
    title: `Contract ${unique()}`,
    category: 'contract',
    ...input,
  })) as { id: string }
  return document.id
}

/** A monthly schedule with one line, starting today, so a period is due now. */
async function createSchedule(input: Record<string, unknown> = {}): Promise<{ id: string; companyId: string }> {
  const companyId = (input.companyId as string | undefined) ?? (await createCompany())
  const schedule = (await run('billingSchedule.create', ownerOfA(), {
    companyId,
    name: `Retainer ${unique()}`,
    lines: [{ description: 'Monthly care plan', unitAmountMinor: 500_00 }],
    ...input,
  })) as { id: string }
  return { id: schedule.id, companyId }
}

type Fixture = () => Promise<unknown>

/**
 * How to exercise each mutation against org A. Returning the input lets one
 * fixture create what the next one acts on.
 *
 * A mutation whose events depend on its input -- a deal can be won or lost --
 * lists several fixtures. The first is the representative one; together they
 * must demonstrate every event the mutation declares.
 */
const MUTATIONS: Record<string, Fixture | Fixture[]> = {
  // A different name each call: an update that changes nothing correctly emits
  // nothing, which would make a repeated fixture look like a missing event.
  'organization.update': async () => ({ name: `Org A ${core.newId().slice(-6)}` }),
  'apiKey.create': async () => ({ name: 'fixture key' }),
  'apiKey.revoke': async () => {
    const created = (await run('apiKey.create', asOwner(ORG_A, ownerA), {
      name: 'to revoke',
    })) as { key: { id: string } }
    return { id: created.key.id }
  },
  // A fresh member each time: this fixture runs once per coverage suite.
  'member.remove': async () => {
    const userId = core.newId()
    await mod.withoutTenant('test: add a removable member', async (db) => {
      await db.execute(sql`insert into "user" (id, name, email)
        values (${userId}::uuid, 'Temp', ${`temp-${userId}@example.com`})`)
      await db.execute(sql`insert into member (id, organization_id, user_id, role)
        values (${core.newId()}::uuid, ${ORG_A}::uuid, ${userId}::uuid, 'developer')`)
    })
    return { userId }
  },
  'webhook.create': async () => ({ url: PUBLIC_HOOK_URL, eventTypes: ['invoice.*'] }),
  'webhook.update': async () => ({ id: await createHook(), description: `changed ${core.newId()}` }),
  'webhook.delete': async () => ({ id: await createHook() }),
  'webhook.rotateSecret': async () => ({ id: await createHook() }),
  'webhook.test': async () => ({ id: await createHook() }),
  'webhookDelivery.retry': async () => {
    const endpointId = await createHook()
    const eventId = core.newId()
    const deliveryId = core.newId()
    await mod.withTenant(ORG_A, async (tx) => {
      await tx.insert(mod.schema.events).values({
        id: eventId, organizationId: ORG_A, type: 'webhook.test', actor: {}, data: {}, publishedAt: new Date(),
      })
      await tx.insert(mod.schema.webhookDeliveries).values({
        id: deliveryId, organizationId: ORG_A, endpointId, eventId, eventType: 'webhook.test',
        status: 'failed', attempts: 8, completedAt: new Date(),
      })
    })
    return { id: deliveryId }
  },

  'company.create': [
    async () => ({ name: `Company ${unique()}` }),
    async () => ({ name: `Client ${unique()}`, lifecycleStage: 'client' }),
  ],
  'company.update': [
    async () => ({ id: await createCompany(), description: `changed ${unique()}` }),
    async () => ({ id: await createCompany(), lifecycleStage: 'client' }),
  ],
  'company.archive': async () => ({ id: await createCompany() }),
  'company.restore': async () => archived('company.archive', await createCompany()),

  'contact.create': async () => ({ firstName: 'Ada', email: `ada-${unique()}@example.com` }),
  'contact.update': async () => ({ id: await createContact(), jobTitle: `Title ${unique()}` }),
  'contact.archive': async () => ({ id: await createContact() }),
  'contact.restore': async () => archived('contact.archive', await createContact()),

  'lead.create': async () => ({ contactName: 'Grace Hopper', source: 'referral' }),
  'lead.update': async () => ({ id: await createLead(), details: `changed ${unique()}` }),
  'lead.changeStatus': async () => ({ id: await createLead(), status: 'contacted' }),
  'lead.convert': [
    // No deal: company, contact, and the company becomes a client at once.
    async () => ({ id: await createLead() }),
    async () => ({ id: await createLead(), deal: { valueMinor: 1_000_000 } }),
  ],
  'lead.archive': async () => ({ id: await createLead() }),
  'lead.restore': async () => archived('lead.archive', await createLead()),

  'deal.create': async () => ({ companyId: await createCompany(), name: `Deal ${unique()}`, valueMinor: 250_000 }),
  'deal.update': async () => ({ id: await createDeal(), name: `Renamed ${unique()}` }),
  'deal.changeStage': [
    async () => ({ id: await createDeal(), stage: 'proposal_sent' }),
    // A fresh prospect, so winning also makes it a client.
    async () => ({ id: await createDeal(), stage: 'won' }),
    async () => ({ id: await createDeal(), stage: 'lost', lostReason: 'Went with another agency' }),
  ],
  'deal.archive': async () => ({ id: await createDeal() }),
  'deal.restore': async () => archived('deal.archive', await createDeal()),

  'activity.create': async () => ({ companyId: await createCompany(), type: 'call', body: 'Discovery call' }),
  'activity.update': async () => {
    const activity = (await run('activity.create', ownerOfA(), {
      companyId: await createCompany(),
      body: 'first draft',
    })) as { id: string }
    return { id: activity.id, body: `edited ${unique()}` }
  },
  'activity.delete': async () => {
    const activity = (await run('activity.create', ownerOfA(), {
      contactId: await createContact(),
      body: 'to delete',
    })) as { id: string }
    return { id: activity.id }
  },

  'project.create': async () => ({ name: `Project ${unique()}`, budgetMinor: 1_000_000 }),
  'project.update': async () => ({ id: await createProject(), description: `changed ${unique()}` }),
  'project.changeStatus': [
    async () => ({ id: await createProject(), status: 'in_progress' }),
    async () => ({ id: await createProject(), status: 'completed' }),
  ],
  'project.archive': async () => ({ id: await createProject() }),
  'project.restore': async () => archived('project.archive', await createProject()),
  'projectMember.add': async () => ({
    id: await createProject(),
    userId: developerA,
    billableRateMinor: 150_00,
    fixedFeeMinor: 4_000_00,
    fixedFeeOn: '2026-09-01',
  }),
  'projectMember.update': [
    async () => {
      const projectId = await createProject()
      const member = (await run('projectMember.add', ownerOfA(), { id: projectId, userId: developerA })) as { id: string }
      return { id: member.id, role: 'manager' }
    },
    // No logged time, so switching a fee on needs no confirmation.
    async () => {
      const member = (await run('projectMember.add', ownerOfA(), { id: await createProject(), userId: developerA })) as { id: string }
      return { id: member.id, fixedFeeMinor: 2_500_00 }
    },
  ],
  'projectMember.remove': async () => {
    const member = (await run('projectMember.add', ownerOfA(), { id: await createProject(), userId: developerA })) as { id: string }
    return { id: member.id }
  },

  'milestone.create': async () => ({ id: await createProject(), name: 'Launch', dueDate: '2026-12-01' }),
  'milestone.update': [
    async () => ({ id: await createMilestone(), name: `Renamed ${unique()}` }),
    async () => ({ id: await createMilestone(), completed: true }),
    async () => {
      const id = await createMilestone()
      await run('milestone.update', ownerOfA(), { id, completed: true })
      return { id, completed: false }
    },
  ],
  'milestone.delete': async () => ({ id: await createMilestone() }),

  'task.create': [
    async () => ({ projectId: await createProject(), title: 'Design homepage' }),
    async () => ({ projectId: await createProject(), title: 'Build homepage', assigneeId: developerA }),
  ],
  'task.update': [
    async () => ({ id: (await createTask()).id, title: `Retitled ${unique()}` }),
    async () => ({ id: (await createTask()).id, assigneeId: developerA }),
  ],
  'task.changeStatus': [
    async () => ({ id: (await createTask()).id, status: 'in_progress' }),
    async () => ({ id: (await createTask()).id, status: 'done' }),
  ],
  'task.delete': async () => ({ id: (await createTask()).id }),
  'taskDependency.add': async () => {
    const first = await createTask()
    const second = await createTask({ projectId: first.projectId })
    return { id: second.id, dependsOnTaskId: first.id }
  },
  'taskDependency.remove': async () => {
    const first = await createTask()
    const second = await createTask({ projectId: first.projectId })
    await run('taskDependency.add', ownerOfA(), { id: second.id, dependsOnTaskId: first.id })
    return { id: second.id, dependsOnTaskId: first.id }
  },

  'comment.create': async () => {
    const task = await createTask()
    return { projectId: task.projectId, taskId: task.id, body: 'Looks good' }
  },
  'comment.update': async () => {
    const comment = (await run('comment.create', ownerOfA(), { projectId: await createProject(), body: 'draft' })) as { id: string }
    return { id: comment.id, body: `edited ${unique()}` }
  },
  'comment.delete': async () => {
    const comment = (await run('comment.create', ownerOfA(), { projectId: await createProject(), body: 'to delete' })) as { id: string }
    return { id: comment.id }
  },

  'rate.set': [
    async () => ({ billableRateMinor: 120_00 + Number.parseInt(unique(), 16) % 1000, costRateMinor: 60_00 }),
    async () => ({ userId: developerA, billableRateMinor: 150_00 + Number.parseInt(unique(), 16) % 1000, costRateMinor: null }),
  ],
  'timeEntry.create': async () => {
    const task = await createTask()
    return { projectId: task.projectId, taskId: task.id, durationSeconds: 5400, description: 'Design review' }
  },
  'timeEntry.update': async () => ({ id: await createEntry(), description: `edited ${unique()}` }),
  'timeEntry.delete': async () => ({ id: await createEntry() }),
  'timer.start': [
    async () => {
      await stopTimer()
      return { projectId: await createProject() }
    },
    // With a timer already running, starting another stops it first.
    async () => {
      await run('timer.start', ownerOfA(), { projectId: await createProject() })
      return { taskId: (await createTask()).id }
    },
  ],
  'timer.stop': async () => {
    const started = (await run('timer.start', ownerOfA(), { projectId: await createProject() })) as { entry: { id: string } }
    return { id: started.entry.id }
  },

  'taxRate.create': async () => ({ name: `GST ${unique()}`, rate: '10' }),
  'taxRate.update': async () => ({ id: await createTaxRate(), description: `changed ${unique()}` }),
  'taxRate.archive': async () => ({ id: await createTaxRate() }),
  'taxRate.restore': async () => archived('taxRate.archive', await createTaxRate()),
  'service.create': async () => ({ name: `Design ${unique()}`, pricingModel: 'hourly', unit: 'hour', defaultPriceMinor: 150_00, defaultTaxRateId: await createTaxRate() }),
  'service.update': async () => ({ id: await createService(), description: `changed ${unique()}` }),
  'service.archive': async () => ({ id: await createService() }),
  'service.restore': async () => archived('service.archive', await createService()),

  'quote.create': async () => ({
    companyId: await createCompany(),
    title: 'Website rebuild',
    lines: [{ serviceId: await createService(), quantity: '12.5' }, { description: 'Hosting setup', unitAmountMinor: 500_00, taxRateId: await createTaxRate() }],
  }),
  'quote.update': async () => ({ id: await createQuote(), title: `Retitled ${unique()}`, discountPercent: '5' }),
  'quote.delete': async () => ({ id: await createQuote() }),
  'quote.send': async () => ({ id: await createQuote() }),
  'quote.accept': async () => ({ id: await sentQuote() }),
  'quote.decline': async () => ({ id: await sentQuote(), reason: 'Budget moved to next year' }),
  'quote.duplicate': async () => ({ id: await sentQuote() }),
  'quoteLine.add': async () => ({ id: await createQuote(), serviceId: await createService(), quantity: 3 }),
  'quoteLine.update': async () => {
    const quote = (await run('quote.get', ownerOfA(), { id: await createQuote() })) as { lines: Array<{ id: string }> }
    return { id: quote.lines[0]!.id, quantity: `${2 + (Number.parseInt(unique(), 16) % 50)}` }
  },
  'quoteLine.remove': async () => {
    const quote = (await run('quote.get', ownerOfA(), { id: await createQuote() })) as { lines: Array<{ id: string }> }
    return { id: quote.lines[0]!.id }
  },

  'invoice.create': async () => ({
    companyId: await createCompany(),
    title: 'Website rebuild',
    lines: [{ description: 'Discovery', unitAmountMinor: 1_500_00, taxRateId: await createTaxRate() }],
  }),
  'invoice.update': async () => ({ id: await createInvoice(), title: `Retitled ${unique()}`, discountPercent: '5' }),
  'invoice.delete': async () => ({ id: await createInvoice() }),
  'invoiceLine.add': async () => ({ id: await createInvoice(), serviceId: await createService(), quantity: 2 }),
  'invoiceLine.update': async () => {
    const invoice = (await run('invoice.get', ownerOfA(), { id: await createInvoice() })) as { lines: Array<{ id: string }> }
    return { id: invoice.lines[0]!.id, quantity: `${2 + (Number.parseInt(unique(), 16) % 40)}` }
  },
  'invoiceLine.remove': async () => {
    const invoice = (await run('invoice.get', ownerOfA(), { id: await createInvoice() })) as { lines: Array<{ id: string }> }
    return { id: invoice.lines[0]!.id }
  },
  'invoice.billTime': async () => {
    const companyId = await createCompany()
    const projectId = await createProject({ companyId })
    await run('rate.set', ownerOfA(), { billableRateMinor: 150_00, costRateMinor: 60_00 })
    await run('timeEntry.create', ownerOfA(), { projectId, durationSeconds: 3600, billable: true })
    const invoice = (await run('invoice.create', ownerOfA(), { companyId, title: `Time ${unique()}` })) as { id: string }
    return { id: invoice.id, projectId }
  },
  'invoice.fromQuote': async () => ({ id: await sentQuote() }),
  'invoice.send': async () => ({ id: await createInvoice() }),
  'invoice.email': async () => ({ id: await sentInvoice(), to: 'client@example.com' }),
  'invoice.cancel': async () => ({ id: await sentInvoice(), reason: 'Raised in error' }),
  'invoice.billExpenses': async () => {
    const companyId = await createCompany()
    await createExpense({ companyId, billable: true, markupPercent: '10' })
    const invoice = (await run('invoice.create', ownerOfA(), { companyId, title: `Expenses ${unique()}` })) as { id: string }
    return { id: invoice.id }
  },

  // One fixture per settled state each of these can leave an invoice in, so
  // that the events they declare are proved to fire rather than asserted to.
  'payment.record': [
    async () => {
      const invoice = await issuedInvoice()
      return { companyId: invoice.companyId, amountMinor: 500_00, reference: `TRF-${unique()}`, allocations: [{ invoiceId: invoice.id }] }
    },
    async () => {
      const invoice = await issuedInvoice()
      return { companyId: invoice.companyId, amountMinor: invoice.totalMinor, allocations: [{ invoiceId: invoice.id }] }
    },
    async () => {
      const invoice = await issuedInvoice({ overdue: true })
      return { companyId: invoice.companyId, amountMinor: 500_00, allocations: [{ invoiceId: invoice.id }] }
    },
    async () => {
      const invoice = await issuedInvoice()
      await pay(invoice)
      return { companyId: invoice.companyId, kind: 'refund', amountMinor: invoice.totalMinor, allocations: [{ invoiceId: invoice.id }] }
    },
  ],
  'payment.update': async () => ({ id: await createPayment(), reference: `Corrected ${unique()}`, method: 'card' }),
  'payment.delete': [
    async () => {
      // Half of it was settled by another payment, so the invoice owes again.
      const invoice = await issuedInvoice()
      const first = await pay(invoice, { amountMinor: invoice.totalMinor / 2 })
      await pay(invoice, { amountMinor: invoice.totalMinor / 2 })
      return { id: first.id }
    },
    async () => {
      // Deleting the refund puts the invoice back to paid.
      const invoice = await issuedInvoice()
      await pay(invoice)
      const refund = await pay(invoice, { kind: 'refund', amountMinor: 500_00 })
      return { id: refund.id }
    },
    async () => {
      const invoice = await issuedInvoice({ overdue: true })
      const payment = await pay(invoice)
      return { id: payment.id }
    },
  ],
  'payment.allocate': [
    async () => {
      const invoice = await issuedInvoice()
      const payment = await pay(invoice, { amountMinor: 500_00, allocate: false })
      return { id: payment.id, invoiceId: invoice.id }
    },
    async () => {
      const invoice = await issuedInvoice()
      const payment = await pay(invoice, { allocate: false })
      return { id: payment.id, invoiceId: invoice.id }
    },
    async () => {
      const invoice = await issuedInvoice({ overdue: true })
      const payment = await pay(invoice, { amountMinor: 500_00, allocate: false })
      return { id: payment.id, invoiceId: invoice.id }
    },
    async () => {
      const invoice = await issuedInvoice()
      await pay(invoice)
      const refund = await pay(invoice, { kind: 'refund', allocate: false })
      return { id: refund.id, invoiceId: invoice.id }
    },
  ],
  'payment.unallocate': [
    async () => {
      const invoice = await issuedInvoice()
      const first = await pay(invoice, { amountMinor: invoice.totalMinor / 2 })
      await pay(invoice, { amountMinor: invoice.totalMinor / 2 })
      return { id: first.allocations[0]!.id }
    },
    async () => {
      const invoice = await issuedInvoice()
      await pay(invoice)
      const refund = await pay(invoice, { kind: 'refund', amountMinor: 500_00 })
      return { id: refund.allocations[0]!.id }
    },
    async () => {
      const invoice = await issuedInvoice({ overdue: true })
      const payment = await pay(invoice)
      return { id: payment.allocations[0]!.id }
    },
  ],

  'expense.create': async () => ({ description: `Stock photography ${unique()}`, amountMinor: 49_00, category: 'software', billable: true, markupPercent: '15' }),
  'expense.update': async () => ({ id: await createExpense(), supplier: `Supplier ${unique()}`, billable: true }),
  'expense.delete': async () => ({ id: await createExpense() }),


  'ticket.create': async () => ({ companyId: await createCompany(), title: `Contact form broken ${unique()}`, body: 'Nothing arrives.', priority: 'high', type: 'bug' }),
  'ticket.update': async () => ({ id: await createTicket(), priority: 'urgent', assigneeId: ownerA }),
  'ticket.changeStatus': [
    async () => ({ id: await createTicket(), status: 'in_progress' }),
    async () => ({ id: await createTicket(), status: 'resolved' }),
    async () => ({ id: await createTicket(), status: 'closed' }),
    // Reopening: the ticket has to have been resolved for the event to fire.
    async () => {
      const id = await createTicket()
      await run('ticket.changeStatus', ownerOfA(), { id, status: 'resolved' })
      return { id, status: 'open' }
    },
  ],
  'ticket.delete': async () => ({ id: await createTicket() }),
  'ticketMessage.create': [
    async () => ({ ticketId: await createTicket(), body: 'Looking into it now.' }),
    async () => ({ ticketId: await createTicket(), body: 'Fixed, please check.', status: 'resolved' }),
    // An internal note announces nothing, which is the point of it.
    async () => ({ ticketId: await createTicket(), body: 'Caused by the SMTP change.', internal: true }),
  ],

  'maintenancePlan.create': async () => ({ companyId: await createCompany(), name: `Care plan ${unique()}`, responseHours: 4, items: ['Security updates'] }),
  'maintenancePlan.update': async () => ({ id: await createPlan(), notes: `Renegotiated ${unique()}`, items: ['Security updates', 'Uptime monitoring'] }),
  'maintenancePlan.changeStatus': [
    async () => ({ id: await createPlan(), status: 'paused' }),
    async () => ({ id: await createPlan(), status: 'ended' }),
  ],
  'maintenancePlan.delete': async () => ({ id: await createPlan() }),
  'maintenanceVisit.create': async () => ({ planId: await createPlan(), summary: `Applied core updates ${unique()}`, kind: 'security_update', minutesSpent: 45 }),
  'maintenanceVisit.delete': async () => ({ id: await createVisit() }),

  'infrastructureAsset.create': async () => ({ name: `example-${unique()}.test`, kind: 'domain', expiresOn: '2030-06-30', renewalCostMinor: 25_00, currency: 'AUD' }),
  'infrastructureAsset.update': async () => ({ id: await createAsset(), provider: `Registrar ${unique()}`, autoRenew: true }),
  'infrastructureAsset.delete': async () => ({ id: await createAsset() }),

  'bankAccount.create': async () => ({ name: `Everyday ${unique()}`, kind: 'bank', openingBalanceOn: '2026-09-01', openingBalanceMinor: 10_000_00 }),
  'bankAccount.update': async () => ({ id: await createBankAccount(), institution: `Bank ${unique()}`, accountIdentifier: '\u20266789' }),
  'bankAccount.archive': async () => ({ id: await createBankAccount() }),
  'bankAccount.restore': async () => {
    const id = await createBankAccount()
    await run('bankAccount.archive', ownerOfA(), { id })
    return { id }
  },

  'bankTransaction.create': async () => ({
    bankAccountId: await createBankAccount(),
    amountMinor: 1_320_00,
    bookedOn: '2026-09-16',
    description: `TRANSFER ACME ${unique()}`,
  }),
  // Money out, so the register is exercised in both directions.
  'bankTransaction.update': async () => ({ id: await createBankTransaction({ amountMinor: -44_00 }), counterparty: `Supplier ${unique()}` }),
  'bankTransaction.delete': async () => ({ id: await createBankTransaction() }),
  'bankTransaction.ignore': async () => ({ id: await createBankTransaction(), reason: `Bank error, reversed ${unique()}` }),
  'bankTransaction.unignore': async () => {
    const id = await createBankTransaction()
    await run('bankTransaction.ignore', ownerOfA(), { id, reason: 'Set aside' })
    return { id }
  },

  'document.upload': async () => ({ companyId: await createCompany(), file: aFile(), title: `Signed contract ${unique()}`, category: 'contract' }),
  'document.update': async () => ({ id: await createDocument(), notes: `Countersigned ${unique()}`, clientVisible: true }),
  'document.delete': async () => ({ id: await createDocument() }),

  'billingSchedule.create': async () => ({
    companyId: await createCompany(),
    name: `Retainer ${unique()}`,
    intervalUnit: 'month',
    lines: [{ description: 'Care plan', unitAmountMinor: 500_00 }],
  }),
  'billingSchedule.update': async () => ({ id: (await createSchedule()).id, name: `Retainer ${unique()}` }),
  'billingSchedule.changeStatus': [
    async () => ({ id: (await createSchedule()).id, status: 'paused' }),
    async () => ({ id: (await createSchedule()).id, status: 'ended' }),
  ],
  'billingSchedule.delete': async () => ({ id: (await createSchedule()).id }),
  'billingScheduleLine.add': async () => ({ scheduleId: (await createSchedule()).id, description: `Extra hours ${unique()}`, unitAmountMinor: 150_00 }),
  'billingScheduleLine.remove': async () => {
    const schedule = (await run('billingSchedule.create', ownerOfA(), {
      companyId: await createCompany(),
      name: `Retainer ${unique()}`,
      lines: [{ description: 'Care plan', unitAmountMinor: 500_00 }, { description: 'Hosting', unitAmountMinor: 50_00 }],
    })) as { id: string; lines: Array<{ id: string }> }
    return { scheduleId: schedule.id, lineId: schedule.lines[1]!.id }
  },
  // One occurrence, so the same call raises the invoice and ends the schedule.
  'billingSchedule.generate': async () => ({ id: (await createSchedule({ maxOccurrences: 1 })).id }),

  'attachment.upload': async () => ({ projectId: await createProject(), file: aFile() }),
  'attachment.delete': async () => {
    const attachment = (await run('attachment.upload', ownerOfA(), { projectId: await createProject(), file: aFile() })) as { id: string }
    return { id: attachment.id }
  },
}

const fixturesFor = (name: string): Fixture[] => [MUTATIONS[name]!].flat()

/** Reads that take a record reference, exercised by the cross-tenant probe. */
const READS: Record<string, Fixture> = {
  'webhook.get': async () => ({ id: await createHook() }),
  'webhookDelivery.list': async () => ({ id: await createHook() }),
  'company.get': async () => ({ id: await createCompany() }),
  'company.summary': async () => ({ id: await createCompany() }),
  'contact.get': async () => ({ id: await createContact() }),
  'lead.get': async () => ({ id: await createLead() }),
  'deal.get': async () => ({ id: await createDeal() }),
  'activity.list': async () => ({ companyId: await createCompany() }),
  'project.get': async () => ({ id: await createProject() }),
  'projectMember.list': async () => ({ id: await createProject() }),
  'milestone.list': async () => ({ id: await createProject() }),
  'task.get': async () => ({ id: (await createTask()).id }),
  'task.list': async () => ({ projectId: await createProject() }),
  'comment.list': async () => ({ projectId: await createProject() }),
  'attachment.list': async () => ({ projectId: await createProject() }),
  'timeEntry.get': async () => ({ id: await createEntry() }),
  'timeEntry.list': async () => ({ projectId: await createProject() }),
  'timeEntry.summary': async () => ({ id: await createProject() }),
  'service.get': async () => ({ id: await createService() }),
  'quote.get': async () => ({ id: await createQuote() }),
  'invoice.get': async () => ({ id: await createInvoice() }),
  'invoice.download': async () => ({ id: await createInvoice() }),
  'invoice.list': async () => ({ companyId: await createCompany() }),
  'payment.get': async () => ({ id: await createPayment() }),
  'payment.list': async () => ({ companyId: await createCompany() }),
  'expense.get': async () => ({ id: await createExpense() }),
  'expense.list': async () => ({ companyId: await createCompany() }),
  'quote.list': async () => ({ companyId: await createCompany() }),
  'project.financials': async () => ({ id: await createProject() }),
  'report.projects': async () => ({ companyId: await createCompany() }),
  'report.revenue': async () => ({ companyId: await createCompany() }),
  'dashboard.get': async () => ({ period: 'month' }),
  'export.run': async () => ({ resource: 'companies' }),
  'attachment.download': async () => {
    const attachment = (await run('attachment.upload', ownerOfA(), { projectId: await createProject(), file: aFile() })) as { id: string }
    return { id: attachment.id }
  },
  'ticket.get': async () => ({ id: await createTicket() }),
  'ticketMessage.list': async () => ({ ticketId: await createTicket() }),
  'maintenancePlan.get': async () => ({ id: await createPlan() }),
  'infrastructureAsset.get': async () => ({ id: await createAsset() }),
  'bankAccount.get': async () => ({ id: await createBankAccount() }),
  'bankTransaction.get': async () => ({ id: await createBankTransaction() }),
  'document.get': async () => ({ id: await createDocument() }),
  'document.download': async () => ({ id: await createDocument() }),
  'billingSchedule.get': async () => ({ id: (await createSchedule()).id }),
  'billingSchedule.invoices': async () => ({ id: (await createSchedule()).id }),
}

describe('audit coverage', () => {
  it('has a fixture for every mutation in the registry', () => {
    const mutations = registry
      .allProcedures()
      .filter((p) => !p.readOnly)
      .map((p) => p.name)
      .sort()
    expect(Object.keys(MUTATIONS).sort()).toEqual(mutations)
  })

  it.each(Object.keys(MUTATIONS))('%s writes an audit entry', async (name) => {
    const input = await fixturesFor(name)[0]!()
    const before = await auditCount(ORG_A)
    await run(name, asOwner(ORG_A, ownerA), input)
    expect(await auditCount(ORG_A)).toBeGreaterThan(before)
  })
})

async function eventTypes(organizationId: string): Promise<string[]> {
  const { rows } = await mod.withTenant(organizationId, (tx) =>
    tx.execute<{ type: string }>(sql`select type from events order by id`),
  )
  return rows.map((r) => r.type)
}

describe('event coverage', () => {
  it('requires every mutation to declare what it emits', () => {
    // An explicit `emits: []` is fine. A missing declaration is how a module
    // ships without webhooks and nobody notices until an integrator asks.
    const undeclared = registry
      .allProcedures()
      .filter((p) => !p.readOnly && p.emits === undefined)
      .map((p) => p.name)
    expect(undeclared).toEqual([])
  })

  it('never declares an event on a read', () => {
    const reads = registry.allProcedures().filter((p) => p.readOnly && (p.emits?.length ?? 0) > 0)
    expect(reads.map((p) => p.name)).toEqual([])
  })

  it.each(Object.keys(MUTATIONS))('%s emits what it declares, and nothing else', async (name) => {
    const procedure = registry.getProcedure(name)!
    const emitted = new Set<string>()
    for (const fixture of fixturesFor(name)) {
      const input = await fixture()
      const before = await eventTypes(ORG_A)
      await run(name, asOwner(ORG_A, ownerA), input)
      for (const type of (await eventTypes(ORG_A)).slice(before.length)) emitted.add(type)
    }

    for (const type of procedure.emits ?? []) {
      expect([...emitted], `${name} declared ${type}`).toContain(type)
    }
    // The reverse matters as much: an undeclared event is one the OpenAPI
    // document and the webhook docs never mention.
    for (const type of emitted) {
      expect(procedure.emits ?? [], `${name} emitted undeclared ${type}`).toContain(type)
    }
  })

  it('leaves no event behind when the transaction rolls back after emitting', async () => {
    // The outbox shares the change's transaction. A failure after emit() must
    // take the event with it -- otherwise a webhook would announce something
    // that never happened.
    const before = await eventTypes(ORG_B)
    await expect(
      mod.withTenant(ORG_B, async (tx) => {
        const ctx = registry.buildContext(asOwner(ORG_B, ownerB), tx)
        await ctx.emit('organization.updated', { name: 'never committed' })
        throw new Error('fails after emitting')
      }),
    ).rejects.toThrow('fails after emitting')
    expect(await eventTypes(ORG_B)).toEqual(before)
  })
})

const REFERENCE_KEYS = ['id', 'companyId', 'contactId', 'leadId', 'dealId', 'projectId', 'taskId', 'milestoneId', 'serviceId', 'taxRateId', 'defaultTaxRateId', 'ticketId', 'planId', 'scheduleId', 'billingScheduleId']

describe('cross-tenant access through procedures', () => {
  it('has a cross-tenant fixture for every read that takes a record id', () => {
    const reads = registry
      .allProcedures()
      .filter((p) => p.readOnly && p.http.path.includes('{'))
      .map((p) => p.name)
    expect(Object.keys(READS)).toEqual(expect.arrayContaining(reads))
  })

  const referencing = [
    ...Object.keys(MUTATIONS).flatMap((name) => fixturesFor(name).map((fixture, i) => [`${name} #${i + 1}`, name, fixture] as const)),
    ...Object.entries(READS).map(([name, fixture]) => [name, name, fixture] as const),
  ]

  it.each(referencing)('%s refuses another organization\'s records', async (_, name, fixture) => {
    // Every fixture builds its records in org A. Replayed by org B's owner, any
    // input that references one of those records must fail as not found --
    // never succeed, and never answer "forbidden", which would confirm the id.
    const input = (await fixture()) as Record<string, unknown>
    if (!REFERENCE_KEYS.some((key) => typeof input[key] === 'string')) return
    await expect(run(name, asOwner(ORG_B, ownerB), input)).rejects.toBeInstanceOf(core.NotFoundError)
  })

  it('cannot revoke another organization\'s API key', async () => {
    const created = (await run('apiKey.create', asOwner(ORG_A, ownerA), {
      name: 'belongs to A',
    })) as { key: { id: string } }

    // Owner of B, full permissions in B, targeting A's key by id. The answer
    // must be "not found" -- not "forbidden", which would confirm it exists.
    await expect(
      run('apiKey.revoke', asOwner(ORG_B, ownerB), { id: created.key.id }),
    ).rejects.toBeInstanceOf(core.NotFoundError)

    const { rows } = await mod.withTenant(ORG_A, (tx) =>
      tx.execute<{ revoked_at: string | null }>(
        sql`select revoked_at from api_keys where id = ${created.key.id}::uuid`,
      ),
    )
    expect(rows[0]?.revoked_at).toBeNull()
  })

  it('lists only the acting organization\'s API keys', async () => {
    await run('apiKey.create', asOwner(ORG_B, ownerB), { name: 'belongs to B' })
    const listed = (await run('apiKey.list', asOwner(ORG_A, ownerA), {})) as {
      data: Array<{ name: string }>
    }
    expect(listed.data.map((k) => k.name)).not.toContain('belongs to B')
  })

  it('cannot remove a member of another organization', async () => {
    const result = await run('member.remove', asOwner(ORG_B, ownerB), { userId: ownerA })
    expect(result).toEqual({ removed: false })

    const { rows } = await mod.withoutTenant('test: check membership', (db) =>
      db.execute(sql`select 1 from member where user_id = ${ownerA}::uuid and organization_id = ${ORG_A}::uuid`),
    )
    expect(rows).toHaveLength(1)
  })

  it('shows only the acting organization\'s audit log', async () => {
    const listed = (await run('auditLog.list', asOwner(ORG_B, ownerB), {})) as {
      data: Array<{ entityLabel: string | null }>
    }
    expect(listed.data.map((e) => e.entityLabel)).not.toContain('belongs to A')
  })
})

describe('authorisation', () => {
  it('refuses every permission-gated procedure to an actor without the permission', async () => {
    const nobody = {
      organizationId: ORG_A,
      actor: { type: 'user' as const, id: ownerA, label: 'no permissions' },
      role: null,
      permissions: new Set<never>(),
    }
    for (const procedure of registry.allProcedures()) {
      if (procedure.permission === 'authenticated') continue
      await expect(
        registry.executeProcedure(procedure.name, { ...nobody, input: {} }),
        procedure.name,
      ).rejects.toBeInstanceOf(core.ForbiddenError)
    }
  })
})

describe('webhooks', () => {
  it('refuses a private or reserved address when the endpoint is saved', async () => {
    for (const url of ['https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/']) {
      await expect(
        run('webhook.create', asOwner(ORG_A, ownerA), { url, eventTypes: ['*'] }),
        url,
      ).rejects.toMatchObject({ name: 'DomainError', code: 'unsafe_url', field: 'url' })
    }
  })

  it('refuses plain http', async () => {
    await expect(
      run('webhook.create', asOwner(ORG_A, ownerA), { url: 'http://93.184.215.14/', eventTypes: ['*'] }),
    ).rejects.toMatchObject({ code: 'unsafe_url' })
  })

  it('refuses a subscription to an event type that does not exist', async () => {
    await expect(
      run('webhook.create', asOwner(ORG_A, ownerA), { url: PUBLIC_HOOK_URL, eventTypes: ['invoice.payed'] }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('stores the signing secret encrypted, and never returns it after creation', async () => {
    const created = (await run('webhook.create', asOwner(ORG_A, ownerA), {
      url: PUBLIC_HOOK_URL,
      eventTypes: ['*'],
    })) as { endpoint: { id: string }; secret: string }

    const { rows } = await mod.withTenant(ORG_A, (tx) =>
      tx.execute<{ secret_encrypted: string }>(
        sql`select secret_encrypted from webhook_endpoints where id = ${created.endpoint.id}::uuid`,
      ),
    )
    expect(rows[0]!.secret_encrypted).not.toContain(created.secret)
    expect(core.decryptSecret(rows[0]!.secret_encrypted)).toBe(created.secret)

    const fetched = await run('webhook.get', asOwner(ORG_A, ownerA), { id: created.endpoint.id })
    expect(JSON.stringify(fetched)).not.toContain(created.secret)
  })

  it('cannot be read, changed, tested, or deleted by another organization', async () => {
    const id = await createHook()
    for (const [name, input] of [
      ['webhook.get', { id }],
      ['webhook.update', { id, enabled: false }],
      ['webhook.test', { id }],
      ['webhook.rotateSecret', { id }],
      ['webhook.delete', { id }],
      ['webhookDelivery.list', { id }],
    ] as const) {
      await expect(run(name, asOwner(ORG_B, ownerB), input), name).rejects.toBeInstanceOf(core.NotFoundError)
    }
  })

  it('resets the failure count when an endpoint is re-enabled', async () => {
    const id = await createHook()
    await mod.withTenant(ORG_A, (tx) =>
      tx.execute(sql`update webhook_endpoints set enabled = false, consecutive_failures = 5,
                     disabled_reason = 'auto' where id = ${id}::uuid`),
    )
    const after = await run('webhook.update', asOwner(ORG_A, ownerA), { id, enabled: true })
    expect(after).toMatchObject({ enabled: true, consecutiveFailures: 0, disabledReason: null })
  })
})

describe('idempotency', () => {
  const asApiKey = (id: string) => ({
    organizationId: ORG_A,
    actor: { type: 'apiKey' as const, id, userId: ownerA, label: 'key' },
    role: 'owner' as const,
    permissions: core.permissionsForRole('owner'),
  })

  async function keyCount(name: string) {
    const { rows } = await mod.withTenant(ORG_A, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from webhook_endpoints where description = ${name}`),
    )
    return rows[0]!.n
  }

  it('runs a repeated request once and replays the original response', async () => {
    const description = `idem ${core.newId()}`
    const input = { url: PUBLIC_HOOK_URL, eventTypes: ['*'], description }
    let replays = 0
    const request = {
      ...asOwner(ORG_A, ownerA),
      input,
      idempotencyKey: `create-${description.replace(/\s/g, '-')}`,
      onReplay: () => replays++,
    }

    const first = await registry.executeProcedure('webhook.create', request)
    const second = await registry.executeProcedure('webhook.create', request)

    expect(await keyCount(description)).toBe(1)
    expect(replays).toBe(1)
    // The replay is the original response -- including the secret shown once,
    // which a client that lost the first response genuinely needs.
    expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)))
  })

  it('rejects a malformed key rather than silently ignoring it', async () => {
    await expect(
      registry.executeProcedure('webhook.create', {
        ...asOwner(ORG_A, ownerA),
        input: { url: PUBLIC_HOOK_URL, eventTypes: ['*'] },
        idempotencyKey: 'has a space',
      }),
    ).rejects.toMatchObject({ code: 'invalid_idempotency_key' })
  })

  it('refuses a key reused for a different request', async () => {
    const key = `reuse-${core.newId()}`
    await registry.executeProcedure('webhook.create', {
      ...asOwner(ORG_A, ownerA),
      input: { url: PUBLIC_HOOK_URL, eventTypes: ['*'] },
      idempotencyKey: key,
    })
    await expect(
      registry.executeProcedure('webhook.create', {
        ...asOwner(ORG_A, ownerA),
        input: { url: PUBLIC_HOOK_URL, eventTypes: ['invoice.*'] },
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
  })

  it('treats the same key from different actors as different requests', async () => {
    // Two integrations that happen to pick the same key must never receive
    // each other's responses: they may hold different permissions.
    const description = `actors ${core.newId()}`
    const input = { url: PUBLIC_HOOK_URL, eventTypes: ['*'], description }
    await registry.executeProcedure('webhook.create', { ...asApiKey(core.newId()), input, idempotencyKey: 'shared' })
    await registry.executeProcedure('webhook.create', { ...asApiKey(core.newId()), input, idempotencyKey: 'shared' })
    expect(await keyCount(description)).toBe(2)
  })

  it('lets a request that failed be retried with the same key', async () => {
    const key = `retry-${core.newId()}`
    await expect(
      registry.executeProcedure('webhook.create', {
        ...asOwner(ORG_A, ownerA),
        input: { url: 'https://127.0.0.1/', eventTypes: ['*'] },
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'unsafe_url' })

    const { rows } = await mod.withTenant(ORG_A, (tx) =>
      tx.execute(sql`select 1 from idempotency_keys where key = ${key}`),
    )
    expect(rows).toHaveLength(0)
  })

  it('runs once when the same key arrives concurrently', async () => {
    const description = `race ${core.newId()}`
    const request = {
      ...asOwner(ORG_A, ownerA),
      input: { url: PUBLIC_HOOK_URL, eventTypes: ['*'], description },
      idempotencyKey: `race-${description.replace(/\s/g, '-')}`,
    }
    await Promise.all(Array.from({ length: 5 }, () => registry.executeProcedure('webhook.create', request)))
    expect(await keyCount(description)).toBe(1)
  })
})

describe('member.remove', () => {
  it('refuses to remove the last owner', async () => {
    await expect(
      run('member.remove', asOwner(ORG_B, ownerB), { userId: ownerB }),
    ).rejects.toMatchObject({ name: 'DomainError', code: 'last_owner' })
  })
})
