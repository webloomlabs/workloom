import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * The single-tenant shape: setup once, then accounts created by an
 * administrator.
 *
 * MULTI_TENANT defaults to false, so the environment is left alone here --
 * which also means these tests fail if that default ever changes silently.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let auth: typeof import('../src/auth.ts').auth
let provisioning: typeof import('../src/provisioning.ts')

const PASSWORD = 'a-sufficiently-long-password'

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  ;({ auth } = await import('../src/auth.ts'))
  provisioning = await import('../src/provisioning.ts')
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

async function auditActions(organizationId: string): Promise<string[]> {
  const { rows } = await mod.withTenant(organizationId, (tx) =>
    tx.execute<{ action: string }>(sql`select action from audit_logs order by id`),
  )
  return rows.map((r) => r.action)
}

let organizationId: string
let adminUserId: string

describe('setup', () => {
  it('reports an empty installation as needing it', async () => {
    expect(await provisioning.isInstalled()).toBe(false)
  })

  it('creates the administrator, the organization, and the owning membership together', async () => {
    const result = await provisioning.completeSetup({
      admin: { name: 'Ada Admin', email: 'Admin@Single.test', password: PASSWORD },
      organizationName: 'Single Tenant Agency',
    })
    organizationId = result.organizationId
    adminUserId = result.userId

    // The address is stored folded, so signing in is not case-sensitive.
    const session = await auth.api.signInEmail({
      body: { email: 'admin@single.test', password: PASSWORD },
      returnHeaders: true,
    })
    expect(session.response.user.id).toBe(result.userId)
    // Taken as verified: an administrator typed it, and there are no
    // invitations here for verification to protect.
    expect(session.response.user.emailVerified).toBe(true)

    const { rows } = await mod.withoutTenant('test: read membership', (db) =>
      db.execute<{ role: string }>(
        sql`select role from member where organization_id = ${organizationId}::uuid`,
      ),
    )
    expect(rows).toEqual([{ role: 'owner' }])
    expect(await auditActions(organizationId)).toContain('organization.created')
  })

  it('refuses once any account exists', async () => {
    expect(await provisioning.isInstalled()).toBe(true)
    await expect(
      provisioning.completeSetup({
        admin: { name: 'Mal Actor', email: 'mal@single.test', password: PASSWORD },
        organizationName: 'Second Agency',
      }),
    ).rejects.toThrow(/already been set up/)
  })
})

describe('public sign-up', () => {
  it('is closed', async () => {
    await expect(
      auth.api.signUpEmail({
        body: { name: 'Mal Actor', email: 'mal@single.test', password: PASSWORD },
      }),
    ).rejects.toThrow()
  })
})

describe('an administrator adding a member', () => {
  it('creates an account that can sign straight in, and audits it as joining', async () => {
    const before = await auditActions(organizationId)

    const { userId, memberId } = await provisioning.provisionMember({
      organizationId,
      role: 'developer',
      person: { name: 'Dev Eloper', email: 'dev@single.test', password: PASSWORD },
      createdBy: { type: 'user', id: adminUserId, label: 'Ada Admin' },
    })
    expect(memberId).toBeTruthy()

    const session = await auth.api.signInEmail({
      body: { email: 'dev@single.test', password: PASSWORD },
      returnHeaders: true,
    })
    expect(session.response.user.id).toBe(userId)

    const added = (await auditActions(organizationId)).slice(before.length)
    expect(added).toContain('member.joined')
  })

  it('refuses an address that already has an account', async () => {
    await expect(
      provisioning.provisionMember({
        organizationId,
        role: 'developer',
        person: { name: 'Dev Again', email: 'DEV@single.test', password: PASSWORD },
        createdBy: { type: 'user', id: adminUserId, label: 'Ada Admin' },
      }),
    ).rejects.toThrow(/already exists/)
  })

  it('refuses a password shorter than the configured minimum', async () => {
    await expect(
      provisioning.provisionMember({
        organizationId,
        role: 'developer',
        person: { name: 'Shorty', email: 'short@single.test', password: 'too-short' },
        createdBy: { type: 'user', id: adminUserId, label: 'Ada Admin' },
      }),
    ).rejects.toThrow(/at least 12 characters/)
  })
})

describe('creating a second organization', () => {
  it('is closed, even for the owner', async () => {
    const signedIn = await auth.api.signInEmail({
      body: { email: 'admin@single.test', password: PASSWORD },
      returnHeaders: true,
    })
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!

    await expect(
      auth.api.createOrganization({
        body: { name: 'Second Agency', slug: 'second-agency' },
        headers: new Headers({ cookie }),
      }),
    ).rejects.toThrow()
  })
})

describe('an administrator setting a member’s password', () => {
  const NEW_PASSWORD = 'a-brand-new-long-password'

  it('changes it, ends every session they had, and audits it', async () => {
    const { userId } = await provisioning.provisionMember({
      organizationId,
      role: 'developer',
      person: { name: 'Forgetful', email: 'forgetful@single.test', password: PASSWORD },
      createdBy: { type: 'user', id: adminUserId, label: 'Ada Admin' },
    })
    const signedIn = await auth.api.signInEmail({ body: { email: 'forgetful@single.test', password: PASSWORD }, returnHeaders: true })
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!

    await provisioning.setMemberPassword({
      organizationId,
      userId,
      password: NEW_PASSWORD,
      setBy: { type: 'user', id: adminUserId, label: 'Ada Admin' },
    })

    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull()
    await expect(auth.api.signInEmail({ body: { email: 'forgetful@single.test', password: PASSWORD } })).rejects.toThrow()
    const again = await auth.api.signInEmail({ body: { email: 'forgetful@single.test', password: NEW_PASSWORD }, returnHeaders: true })
    expect(again.response.user.id).toBe(userId)
    expect(await auditActions(organizationId)).toContain('member.password_set')
  })

  it('refuses someone who is not a member, and a short password', async () => {
    const setBy = { type: 'user' as const, id: adminUserId, label: 'Ada Admin' }
    await expect(
      provisioning.setMemberPassword({ organizationId, userId: '01a0dd00-0000-7000-8000-00000000dead', password: NEW_PASSWORD, setBy }),
    ).rejects.toThrow(/not a member/)
    await expect(provisioning.setMemberPassword({ organizationId, userId: adminUserId, password: 'too-short', setBy })).rejects.toThrow(/at least 12 characters/)
  })
})
