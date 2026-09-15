import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Membership, invitations, and their audit trail -- driven through Better
 * Auth's real endpoints rather than by inserting rows, because the hooks and
 * permission checks under test only run on that path.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let auth: typeof import('../src/auth.ts').auth
let emails: typeof import('@workloom/emails')

const PASSWORD = 'a-sufficiently-long-password'
let organizationId: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  ;({ auth } = await import('../src/auth.ts'))
  emails = await import('@workloom/emails')
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

async function signUp(email: string, name: string, verified: boolean) {
  await auth.api.signUpEmail({ body: { email, password: PASSWORD, name } })
  if (verified) await markVerified(email)
}

async function markVerified(email: string) {
  await mod.withoutTenant('test: verify email', (db) =>
    db.execute(sql`update "user" set email_verified = true where email = ${email}`),
  )
}

/** Signs in through the real endpoint and returns headers carrying the session. */
async function signIn(email: string): Promise<Headers> {
  const response = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  })
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!
  return new Headers({ cookie })
}

async function auditActions(): Promise<string[]> {
  const { rows } = await mod.withTenant(organizationId, (tx) =>
    tx.execute<{ action: string }>(sql`select action from audit_logs order by id`),
  )
  return rows.map((r) => r.action)
}

describe('an organization', () => {
  it('records its own creation', async () => {
    await signUp('owner@acme.test', 'Olive Owner', true)
    const headers = await signIn('owner@acme.test')
    const org = await auth.api.createOrganization({
      body: { name: 'Acme Agency', slug: 'acme-agency' },
      headers,
    })
    organizationId = org!.id

    expect(await auditActions()).toContain('organization.created')
  })

  it('records sign-ins by its members', async () => {
    await signIn('owner@acme.test')
    expect(await auditActions()).toContain('auth.signed_in')
  })
})

describe('invitations', () => {
  let invitationId: string

  it('are sent by email and audited', async () => {
    emails.clearSentEmails()
    const headers = await signIn('owner@acme.test')
    const invitation = await auth.api.createInvitation({
      body: { email: 'dev@acme.test', role: 'developer', organizationId },
      headers,
    })
    invitationId = invitation.id

    const sent = emails.sentEmails()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('dev@acme.test')
    expect(sent[0]!.text).toContain(`/accept-invitation/${invitationId}`)

    expect(await auditActions()).toContain('member.invited')
  })

  it('cannot be accepted from an address that has not been verified', async () => {
    // Otherwise a leaked invitation link plus a sign-up using the invitee's
    // address would be enough to join someone else's organization.
    await signUp('dev@acme.test', 'Dev Eloper', false)
    await mod.withoutTenant('test: ensure unverified', (db) =>
      db.execute(sql`update "user" set email_verified = false where email = 'dev@acme.test'`),
    )
    const headers = await signIn('dev@acme.test').catch(() => null)

    // Better Auth may refuse the sign-in outright or refuse the acceptance;
    // either way, no membership may result.
    if (headers) {
      await expect(
        auth.api.acceptInvitation({ body: { invitationId }, headers }),
      ).rejects.toThrow()
    }

    const { rows } = await mod.withoutTenant('test: check membership', (db) =>
      db.execute(sql`
        select 1 from member m join "user" u on u.id = m.user_id
        where u.email = 'dev@acme.test' and m.organization_id = ${organizationId}::uuid
      `),
    )
    expect(rows).toHaveLength(0)
  })

  it('tells an unverified recipient why they cannot see the invitation', async () => {
    // The accept-invitation page branches on this exact code to decide whether
    // to ask for email confirmation. Pinned so a Better Auth upgrade that
    // renames it fails here rather than silently breaking the join flow.
    const authMod = await import('../src/errors.ts')
    const headers = await signIn('dev@acme.test')
    const error = await auth.api
      .getInvitation({ query: { id: invitationId }, headers })
      .then(() => null, (e: unknown) => e)
    expect(authMod.authErrorCode(error)).toBe('EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION')
  })

  it('once verified, joins the invitee with the invited role, and audits it', async () => {
    await markVerified('dev@acme.test')
    const headers = await signIn('dev@acme.test')
    await auth.api.acceptInvitation({ body: { invitationId }, headers })

    const { rows } = await mod.withoutTenant('test: read role', (db) =>
      db.execute<{ role: string }>(sql`
        select m.role from member m join "user" u on u.id = m.user_id
        where u.email = 'dev@acme.test' and m.organization_id = ${organizationId}::uuid
      `),
    )
    expect(rows[0]?.role).toBe('developer')
    expect(await auditActions()).toContain('member.joined')
  })

  it('cannot be issued by a role without member management', async () => {
    const headers = await signIn('dev@acme.test')
    await expect(
      auth.api.createInvitation({
        body: { email: 'escalate@acme.test', role: 'owner', organizationId },
        headers,
      }),
    ).rejects.toThrow()
  })
})

describe('removing a member', () => {
  it('is audited with the role they held', async () => {
    const headers = await signIn('owner@acme.test')
    await auth.api.removeMember({
      body: { memberIdOrEmail: 'dev@acme.test', organizationId },
      headers,
    })

    const { rows } = await mod.withTenant(organizationId, (tx) =>
      tx.execute<{ changes: { role: { from: string; to: null } } }>(
        sql`select changes from audit_logs where action = 'member.removed'`,
      ),
    )
    expect(rows[0]?.changes).toEqual({ role: { from: 'developer', to: null } })
  })
})

describe('the last owner', () => {
  // These go through Better Auth's own endpoints on purpose. The procedure in
  // packages/core guards member.remove itself; Better Auth's /api/auth endpoints
  // bypass the registry, and currently enforce the same rule internally. The
  // tests assert the outcome rather than Better Auth's wording, so an upgrade
  // that quietly drops that check fails here.
  async function ownerCount() {
    const { rows } = await mod.withoutTenant('test: count owners', (db) =>
      db.execute(sql`select 1 from member where organization_id = ${organizationId}::uuid and role = 'owner'`),
    )
    return rows.length
  }

  it('cannot be removed through Better Auth', async () => {
    const headers = await signIn('owner@acme.test')
    await expect(
      auth.api.removeMember({ body: { memberIdOrEmail: 'owner@acme.test', organizationId }, headers }),
    ).rejects.toThrow()
    expect(await ownerCount()).toBe(1)
  })

  it('cannot be demoted through Better Auth', async () => {
    const headers = await signIn('owner@acme.test')
    const { rows } = await mod.withoutTenant('test: find owner member', (db) =>
      db.execute<{ id: string }>(sql`
        select m.id from member m join "user" u on u.id = m.user_id
        where u.email = 'owner@acme.test' and m.organization_id = ${organizationId}::uuid`),
    )
    await expect(
      auth.api.updateMemberRole({
        body: { memberId: rows[0]!.id, role: 'admin', organizationId },
        headers,
      }),
    ).rejects.toThrow()
    expect(await ownerCount()).toBe(1)
  })

  it('cannot leave the organization', async () => {
    const headers = await signIn('owner@acme.test')
    await expect(
      auth.api.leaveOrganization({ body: { organizationId }, headers }),
    ).rejects.toThrow()
    expect(await ownerCount()).toBe(1)
  })

  it('can step down once there is another owner', async () => {
    await signUp('second@acme.test', 'Sam Second', true)
    const ownerHeaders = await signIn('owner@acme.test')
    const invitation = await auth.api.createInvitation({
      body: { email: 'second@acme.test', role: 'owner', organizationId },
      headers: ownerHeaders,
    })
    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: await signIn('second@acme.test'),
    })

    const { rows } = await mod.withoutTenant('test: find original owner', (db) =>
      db.execute<{ id: string }>(sql`
        select m.id from member m join "user" u on u.id = m.user_id
        where u.email = 'owner@acme.test' and m.organization_id = ${organizationId}::uuid`),
    )
    await auth.api.updateMemberRole({
      body: { memberId: rows[0]!.id, role: 'admin', organizationId },
      headers: ownerHeaders,
    })
    expect(await ownerCount()).toBe(1)
  })
})
