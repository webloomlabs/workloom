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

/**
 * How to exercise each mutation against org A. Returning the input lets one
 * fixture create what the next one acts on.
 */
const MUTATIONS: Record<string, () => Promise<unknown>> = {
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
    const input = await MUTATIONS[name]!()
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

  it.each(Object.keys(MUTATIONS))('%s emits what it declares', async (name) => {
    const procedure = registry.getProcedure(name)!
    const input = await MUTATIONS[name]!()
    const before = await eventTypes(ORG_A)
    await run(name, asOwner(ORG_A, ownerA), input)
    const emitted = (await eventTypes(ORG_A)).slice(before.length)

    for (const type of procedure.emits ?? []) {
      expect(emitted, `${name} declared ${type}`).toContain(type)
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

describe('cross-tenant access through procedures', () => {
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
