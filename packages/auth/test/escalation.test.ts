import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Privilege escalation through Better Auth's own endpoints.
 *
 * An admin holds every permission except deleting the organization. If an
 * admin could make anyone an owner -- a colleague, a second account of their
 * own, or themselves -- that single remaining distinction would be meaningless.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let auth: typeof import('../src/auth.ts').auth

const PASSWORD = 'a-sufficiently-long-password'
let organizationId: string

async function account(email: string) {
  await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } })
  await mod.withoutTenant('test: verify', (db) =>
    db.execute(sql`update "user" set email_verified = true where email = ${email}`),
  )
}

async function signIn(email: string): Promise<Headers> {
  const r = await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true })
  return new Headers({ cookie: r.headers.get('set-cookie')!.split(';')[0]! })
}

async function roleOf(email: string) {
  const { rows } = await mod.withoutTenant('test: role', (db) =>
    db.execute<{ role: string }>(sql`
      select m.role from member m join "user" u on u.id = m.user_id
      where u.email = ${email} and m.organization_id = ${organizationId}::uuid`),
  )
  return rows[0]?.role
}

async function memberId(email: string) {
  const { rows } = await mod.withoutTenant('test: member id', (db) =>
    db.execute<{ id: string }>(sql`
      select m.id from member m join "user" u on u.id = m.user_id
      where u.email = ${email} and m.organization_id = ${organizationId}::uuid`),
  )
  return rows[0]!.id
}

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  ;({ auth } = await import('../src/auth.ts'))

  for (const email of ['owner@x.test', 'admin@x.test', 'dev@x.test', 'alt@x.test']) await account(email)

  const owner = await signIn('owner@x.test')
  const org = await auth.api.createOrganization({ body: { name: 'X', slug: 'x' }, headers: owner })
  organizationId = org!.id

  for (const [email, role] of [['admin@x.test', 'admin'], ['dev@x.test', 'developer']] as const) {
    const invitation = await auth.api.createInvitation({ body: { email, role, organizationId }, headers: owner })
    await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: await signIn(email) })
  }
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

describe('an admin', () => {
  it('cannot invite someone as an owner', async () => {
    const admin = await signIn('admin@x.test')
    await expect(
      auth.api.createInvitation({ body: { email: 'alt@x.test', role: 'owner', organizationId }, headers: admin }),
    ).rejects.toThrow(/role/i)

    // And the same admin CAN invite with a lesser role -- so the refusal above
    // is about the owner role specifically, not a blanket failure.
    await expect(
      auth.api.createInvitation({ body: { email: 'alt@x.test', role: 'developer', organizationId }, headers: admin }),
    ).resolves.toBeTruthy()
  })

  it('cannot promote themselves to owner', async () => {
    const admin = await signIn('admin@x.test')
    await auth.api
      .updateMemberRole({ body: { memberId: await memberId('admin@x.test'), role: 'owner', organizationId }, headers: admin })
      .catch(() => undefined)
    expect(await roleOf('admin@x.test')).toBe('admin')
  })

  it('cannot promote someone else to owner', async () => {
    const admin = await signIn('admin@x.test')
    await auth.api
      .updateMemberRole({ body: { memberId: await memberId('dev@x.test'), role: 'owner', organizationId }, headers: admin })
      .catch(() => undefined)
    expect(await roleOf('dev@x.test')).toBe('developer')
  })

  it('can still change non-owner roles', async () => {
    const admin = await signIn('admin@x.test')
    await auth.api.updateMemberRole({
      body: { memberId: await memberId('dev@x.test'), role: 'manager', organizationId },
      headers: admin,
    })
    expect(await roleOf('dev@x.test')).toBe('manager')
  })

  it('cannot demote an owner', async () => {
    const admin = await signIn('admin@x.test')
    await auth.api
      .updateMemberRole({ body: { memberId: await memberId('owner@x.test'), role: 'developer', organizationId }, headers: admin })
      .catch(() => undefined)
    expect(await roleOf('owner@x.test')).toBe('owner')
  })

  it('cannot remove an owner', async () => {
    const admin = await signIn('admin@x.test')
    await auth.api
      .removeMember({ body: { memberIdOrEmail: 'owner@x.test', organizationId }, headers: admin })
      .catch(() => undefined)
    expect(await roleOf('owner@x.test')).toBe('owner')
  })
})

describe('a member without member management', () => {
  // dev@x.test was made a manager above; managers cannot change roles either.
  it('cannot change anyone\'s role, including their own', async () => {
    const dev = await signIn('dev@x.test')
    await auth.api
      .updateMemberRole({ body: { memberId: await memberId('dev@x.test'), role: 'owner', organizationId }, headers: dev })
      .catch(() => undefined)
    expect(await roleOf('dev@x.test')).not.toBe('owner')
  })
})
