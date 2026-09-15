import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * The outbox, end to end: a committed change becomes a signed HTTP request at
 * a real receiver; a failing receiver is retried on schedule and eventually
 * switched off; a private address is refused; nothing crosses organizations.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('@workloom/core')
let registry: typeof import('@workloom/core/registry')
let publish: typeof import('../src/outbox/publish.ts')
let deliver: typeof import('../src/outbox/deliver.ts')
let scope: typeof import('../src/outbox/scope.ts')

let server: Server
let receiverUrl: string
/** What the receiver should answer next, per path. */
const behaviour = new Map<string, number>()
const received: Array<{ path: string; headers: IncomingHttpHeaders; body: string }> = []

const ORG_A = '01a0b000-0000-7000-8000-00000000000a'
const ORG_B = '01a0b000-0000-7000-8000-00000000000b'
let ownerA: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('@workloom/core')
  registry = await import('@workloom/core/registry')
  await import('@workloom/core/modules')
  publish = await import('../src/outbox/publish.ts')
  deliver = await import('../src/outbox/deliver.ts')
  scope = await import('../src/outbox/scope.ts')

  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ path: req.url!, headers: req.headers, body })
      res.writeHead(behaviour.get(req.url!) ?? 200).end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  ownerA = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`insert into organization (id, name, slug) values
      (${ORG_A}::uuid, 'A', 'a'), (${ORG_B}::uuid, 'B', 'b')`)
    await db.execute(sql`insert into "user" (id, name, email) values (${ownerA}::uuid, 'Owner', 'o@a.test')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role)
      values (${core.newId()}::uuid, ${ORG_A}::uuid, ${ownerA}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await mod?.closePool()
  await database?.stop()
})

beforeEach(async () => {
  received.length = 0
  behaviour.clear()
  // Each test starts with no endpoints and an empty outbox.
  for (const org of [ORG_A, ORG_B]) {
    await mod.withTenant(org, async (tx) => {
      await tx.execute(sql`delete from webhook_endpoints`)
      await tx.execute(sql`delete from events`)
    })
  }
})

/** Inserts an endpoint directly, bypassing URL validation (the receiver is local). */
async function endpoint(organizationId: string, path: string, eventTypes: string[], extra: Record<string, unknown> = {}) {
  const secret = core.generateWebhookSecret()
  const id = core.newId()
  await mod.withTenant(organizationId, (tx) =>
    tx.insert(mod.schema.webhookEndpoints).values({
      id,
      organizationId,
      url: `${receiverUrl}${path}`,
      eventTypes,
      secretEncrypted: core.encryptSecret(secret),
      ...extra,
    }),
  )
  return { id, secret }
}

function asOwnerA() {
  return {
    organizationId: ORG_A,
    actor: { type: 'user' as const, id: ownerA, label: 'Owner' },
    role: 'owner' as const,
    permissions: core.permissionsForRole('owner'),
  }
}

/** One full dispatcher cycle, with local delivery permitted. */
async function cycle() {
  await publish.publishPendingEvents()
  await deliver.deliverDue({ allowPrivate: true })
}

async function deliveries(organizationId: string) {
  return mod.withTenant(organizationId, (tx) =>
    tx.select().from(mod.schema.webhookDeliveries).orderBy(mod.schema.webhookDeliveries.id),
  )
}

/** Pretends the retry delay has passed. */
async function makeDue(organizationId: string) {
  await mod.withTenant(organizationId, (tx) =>
    tx.execute(sql`update webhook_deliveries set next_attempt_at = now() - interval '1 second'
                   where status = 'pending'`),
  )
}

describe('a committed change', () => {
  it('reaches a subscribed receiver as a request that verifies with the endpoint secret', async () => {
    const hook = await endpoint(ORG_A, '/keys', ['api_key.*'])
    const created = (await registry.executeProcedure('apiKey.create', {
      ...asOwnerA(),
      input: { name: 'for n8n' },
    })) as { secret: string }

    await cycle()

    expect(received).toHaveLength(1)
    const [request] = received
    const payload = JSON.parse(request!.body)
    expect(payload).toMatchObject({
      type: 'api_key.created',
      organization_id: ORG_A,
      version: 1,
      actor: { type: 'user', id: ownerA },
      data: { name: 'for n8n' },
    })
    // The display prefix is fine; the secret itself must never leave, because
    // the outbox fans out to third-party URLs.
    expect(request!.body).not.toContain(created.secret)
    expect(request!.body).not.toContain(created.secret.slice(-20))

    expect(request!.headers['workloom-event-type']).toBe('api_key.created')
    expect(request!.headers['workloom-event-id']).toBe(payload.id)
    expect(
      core.verifySignature({
        header: request!.headers['workloom-signature'] as string,
        body: request!.body,
        secret: hook.secret,
      }),
    ).toBe(true)

    const [delivery] = await deliveries(ORG_A)
    expect(delivery).toMatchObject({ status: 'succeeded', attempts: 1, responseStatus: 200 })
  })

  it('does not reach endpoints that are not subscribed to it', async () => {
    await endpoint(ORG_A, '/invoices-only', ['invoice.*'])
    await registry.executeProcedure('apiKey.create', { ...asOwnerA(), input: { name: 'k' } })
    await cycle()
    expect(received).toHaveLength(0)
  })

  it('never reaches another organization\'s endpoints', async () => {
    await endpoint(ORG_B, '/org-b', ['*'])
    await registry.executeProcedure('apiKey.create', { ...asOwnerA(), input: { name: 'k' } })
    await cycle()
    expect(received).toHaveLength(0)
  })

  it('is published once, even when two dispatchers run at the same moment', async () => {
    await endpoint(ORG_A, '/once', ['*'])
    for (let i = 0; i < 20; i++) {
      await registry.executeProcedure('apiKey.create', { ...asOwnerA(), input: { name: `k${i}` } })
    }
    // SKIP LOCKED: concurrent publishers take disjoint batches.
    await Promise.all([publish.publishPendingEvents(7), publish.publishPendingEvents(7), publish.publishPendingEvents(7)])
    await publish.publishPendingEvents()
    expect(await deliveries(ORG_A)).toHaveLength(20)
  })
})

describe('a failing receiver', () => {
  it('is retried later, with backoff, and succeeds when it recovers', async () => {
    await endpoint(ORG_A, '/flaky', ['*'])
    behaviour.set('/flaky', 500)
    await registry.executeProcedure('apiKey.create', { ...asOwnerA(), input: { name: 'k' } })

    await cycle()
    let [delivery] = await deliveries(ORG_A)
    expect(delivery).toMatchObject({ status: 'pending', attempts: 1, responseStatus: 500 })
    const wait = delivery!.nextAttemptAt!.getTime() - delivery!.lastAttemptAt!.getTime()
    expect(wait).toBeGreaterThanOrEqual(12_000) // 15 s, less 20% jitter

    // Not yet due: nothing happens.
    await deliver.deliverDue({ allowPrivate: true })
    expect(received).toHaveLength(1)

    behaviour.set('/flaky', 204)
    await makeDue(ORG_A)
    await deliver.deliverDue({ allowPrivate: true })
    ;[delivery] = await deliveries(ORG_A)
    expect(delivery).toMatchObject({ status: 'succeeded', attempts: 2, responseStatus: 204 })
    expect(received[1]!.headers['workloom-delivery-attempt']).toBe('2')
    // Same event, same bytes, on every attempt.
    expect(received[1]!.body).toBe(received[0]!.body)
  })

  it('fails a delivery after eight attempts', async () => {
    await endpoint(ORG_A, '/down', ['*'])
    behaviour.set('/down', 503)
    await registry.executeProcedure('apiKey.create', { ...asOwnerA(), input: { name: 'k' } })
    await publish.publishPendingEvents()

    for (let i = 0; i < core.MAX_ATTEMPTS; i++) {
      await makeDue(ORG_A)
      await deliver.deliverDue({ allowPrivate: true })
    }
    const [delivery] = await deliveries(ORG_A)
    expect(delivery).toMatchObject({ status: 'failed', attempts: core.MAX_ATTEMPTS })
    expect(delivery!.completedAt).not.toBeNull()

    // And then stops.
    await makeDue(ORG_A)
    await deliver.deliverDue({ allowPrivate: true })
    expect(received).toHaveLength(core.MAX_ATTEMPTS)
  })

  it('is switched off, with a reason, after repeated exhausted deliveries', async () => {
    const hook = await endpoint(ORG_A, '/dead', ['*'], {
      consecutiveFailures: core.DISABLE_AFTER_CONSECUTIVE_FAILURES - 1,
    })
    behaviour.set('/dead', 500)
    await registry.executeProcedure('apiKey.create', { ...asOwnerA(), input: { name: 'k' } })
    await publish.publishPendingEvents()
    for (let i = 0; i < core.MAX_ATTEMPTS; i++) {
      await makeDue(ORG_A)
      await deliver.deliverDue({ allowPrivate: true })
    }

    const [row] = await mod.withTenant(ORG_A, (tx) =>
      tx.select().from(mod.schema.webhookEndpoints).where(sql`id = ${hook.id}::uuid`),
    )
    expect(row).toMatchObject({ enabled: false })
    expect(row!.disabledReason).toMatch(/Disabled automatically.*receiver responded 500/)

    // A disabled endpoint receives nothing further.
    received.length = 0
    await registry.executeProcedure('apiKey.create', { ...asOwnerA(), input: { name: 'k2' } })
    await cycle()
    expect(received).toHaveLength(0)
  })
})

describe('private addresses', () => {
  it('are refused at delivery time when not explicitly allowed', async () => {
    await endpoint(ORG_A, '/internal', ['*'])
    await registry.executeProcedure('apiKey.create', { ...asOwnerA(), input: { name: 'k' } })
    await publish.publishPendingEvents()
    await deliver.deliverDue({ allowPrivate: false })

    expect(received).toHaveLength(0)
    const [delivery] = await deliveries(ORG_A)
    expect(delivery!.error).toMatch(/refused/)
  })
})

describe('test events', () => {
  it('go only to the endpoint they name, even a disabled one, and are not retried', async () => {
    const target = await endpoint(ORG_A, '/target', ['invoice.paid'], { enabled: false })
    await endpoint(ORG_A, '/bystander', ['*'])

    await registry.executeProcedure('webhook.test', { ...asOwnerA(), input: { id: target.id } })
    await cycle()
    expect(received.map((r) => r.path)).toEqual(['/target'])

    behaviour.set('/target', 500)
    await registry.executeProcedure('webhook.test', { ...asOwnerA(), input: { id: target.id } })
    await cycle()
    const failed = (await deliveries(ORG_A)).at(-1)
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 })
  })
})

describe('secret rotation', () => {
  it('signs with both secrets during the overlap, so receivers can switch at leisure', async () => {
    const hook = await endpoint(ORG_A, '/rotating', ['webhook.test'])
    const rotated = (await registry.executeProcedure('webhook.rotateSecret', {
      ...asOwnerA(),
      input: { id: hook.id },
    })) as { secret: string }

    await registry.executeProcedure('webhook.test', { ...asOwnerA(), input: { id: hook.id } })
    await cycle()

    const [request] = received
    for (const secret of [hook.secret, rotated.secret]) {
      expect(
        core.verifySignature({ header: request!.headers['workloom-signature'] as string, body: request!.body, secret }),
      ).toBe(true)
    }
  })
})

describe('the dispatcher scope', () => {
  it('does not outlive its transaction on a pooled connection', async () => {
    await endpoint(ORG_A, '/scope', ['*'])
    await scope.withDispatcher(async (tx) => {
      const { rows } = await tx.execute(sql`select 1 from webhook_endpoints`)
      expect(rows.length).toBeGreaterThan(0)
    })
    // Many unscoped queries, so at least one lands on the connection that just
    // held the flag. None may see any tenant's rows.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        mod.withoutTenant('test: probe for leaked scope', (db) => db.execute(sql`select 1 from webhook_endpoints`)),
      ),
    )
    for (const { rows } of results) expect(rows).toHaveLength(0)
  })
})
