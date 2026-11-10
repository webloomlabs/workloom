import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { env } from '@workloom/config'
import { consumeRateLimit, DomainError, ForbiddenError, isRole, newId, roleHasPermission, type Actor } from '@workloom/core'
import { resetOrganizationData, type OrganizationResetResult } from '@workloom/core/modules'
// The auth tables are not tenant-scoped, so this module is one of the few
// permitted to use the unscoped client. See docs/architecture.md.
import { and, db, eq, schema, sql } from '@workloom/db'
import { organizationResetCodeEmail, sendEmail } from '@workloom/emails'
import { recordAuthEvent } from './audit-hooks.ts'
import { auth } from './auth.ts'

/**
 * Resetting an organization: deleting every record it has, for good.
 *
 * Nothing else in Workloom destroys this much at once, and nothing can bring
 * it back except a database backup, so it asks for more than a session:
 *
 *   1. The person's own password, typed now. A session left signed in on a
 *      shared machine, or a stolen cookie, is not enough.
 *   2. A six-digit code sent to their email address, entered within ten
 *      minutes. A password alone -- reused, phished, or written down -- is not
 *      enough either.
 *
 * Only a role holding `organization:delete` may ask, which is the owner: an
 * admin can run everything but cannot destroy the organization, and a reset
 * is destroying it in all but name. The role is re-read at each step, so
 * someone demoted between the two cannot finish.
 *
 * The code is stored as an HMAC, never as itself, in Better Auth's
 * `verification` table under an identifier bound to the organization and the
 * person. It works once, for ten minutes, and five wrong guesses spend it.
 */

export const RESET_CODE_MINUTES = 10
const MAX_CODE_ATTEMPTS = 5
const TOO_MANY = 'Too many attempts. Wait a minute and try again.'

type RequestContext = { headers?: Headers } | undefined

const identifierFor = (organizationId: string, userId: string) => `organization-reset:${organizationId}:${userId}`

function digest(identifier: string, code: string): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET).update(`${identifier}:${code}`).digest('hex')
}

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

async function limit(key: string, klass: 'auth' | 'authMail'): Promise<void> {
  const decision = await consumeRateLimit(`organization-reset:${key}`, klass)
  if (!decision.allowed) throw new DomainError(TOO_MANY, 'rate_limited')
}

/** Throws unless this person, right now, holds the owner's power over this organization. */
async function assertMayReset(organizationId: string, userId: string): Promise<{ email: string; name: string; organizationName: string }> {
  const [row] = await db
    .select({ role: schema.member.role, email: schema.user.email, name: schema.user.name, organizationName: schema.organization.name })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
    .limit(1)
  if (!row || !isRole(row.role) || !roleHasPermission(row.role, 'organization:delete')) {
    throw new ForbiddenError('organization:delete')
  }
  return row
}

/**
 * Step one: checks the password and, if it is right, emails a code.
 *
 * Asking again replaces any earlier code, so only the newest email works.
 */
export async function requestOrganizationReset(input: {
  organizationId: string
  userId: string
  password: string
  actor: Actor
  context?: RequestContext
}): Promise<{ email: string; expiresAt: Date }> {
  await limit(`password:${input.userId}`, 'auth')
  const person = await assertMayReset(input.organizationId, input.userId)

  const [credential] = await db
    .select({ hash: schema.account.password })
    .from(schema.account)
    .where(and(eq(schema.account.userId, input.userId), eq(schema.account.providerId, 'credential')))
    .limit(1)
  if (!credential?.hash) {
    throw new DomainError('Your account has no password to confirm with. Set one from "Forgot password?" first.', 'no_password', 'password')
  }
  const context = await auth.$context
  if (!input.password || !(await context.password.verify({ password: input.password, hash: credential.hash }))) {
    throw new DomainError('That password is not right.', 'invalid_password', 'password')
  }

  // Each request sends mail; keep it to a few a minute.
  await limit(`mail:${input.userId}`, 'authMail')

  const identifier = identifierFor(input.organizationId, input.userId)
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = new Date(Date.now() + RESET_CODE_MINUTES * 60_000)
  await db.transaction(async (tx) => {
    await tx.delete(schema.verification).where(eq(schema.verification.identifier, identifier))
    await tx.insert(schema.verification).values({
      id: newId(),
      identifier,
      value: JSON.stringify({ digest: digest(identifier, code), attempts: 0 }),
      expiresAt,
    })
  })

  try {
    await sendEmail(
      organizationResetCodeEmail({ to: person.email, organizationName: person.organizationName, code, expiresInMinutes: RESET_CODE_MINUTES }),
    )
  } catch (error) {
    await db.delete(schema.verification).where(eq(schema.verification.identifier, identifier))
    console.error('[organization-reset] could not send the code', error)
    throw new DomainError('The code could not be emailed. Check the mail settings and try again.', 'mail_failed')
  }

  await recordAuthEvent({
    organizationId: input.organizationId,
    actor: input.actor,
    entry: { action: 'organization.reset_requested', entityType: 'organization', entityId: input.organizationId, entityLabel: person.organizationName },
    context: input.context,
  })

  return { email: person.email, expiresAt }
}

type CodeCheck = { ok: true } | { ok: false; message: string; code: string }

/**
 * Spends the code if it is right, counts the attempt if it is not. Commits
 * either way -- a wrong guess must still count -- and only the caller that
 * deletes the row can go on, so two confirmations at once wipe once.
 */
async function checkCode(identifier: string, code: string): Promise<CodeCheck> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string; value: string; expires_at: Date }>(
      sql`select id, value, expires_at from verification where identifier = ${identifier} for update`,
    )
    const row = rows[0]
    const expired: CodeCheck = { ok: false, message: 'That code has expired. Start again to get a new one.', code: 'code_expired' }
    if (!row) return expired
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await tx.delete(schema.verification).where(eq(schema.verification.id, row.id))
      return expired
    }

    const stored = JSON.parse(row.value) as { digest: string; attempts: number }
    if (/^\d{6}$/.test(code) && sameDigest(stored.digest, digest(identifier, code))) {
      await tx.delete(schema.verification).where(eq(schema.verification.id, row.id))
      return { ok: true }
    }

    const attempts = stored.attempts + 1
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await tx.delete(schema.verification).where(eq(schema.verification.id, row.id))
      return { ok: false, message: 'Too many wrong codes. Start again to get a new one.', code: 'code_spent' }
    }
    await tx
      .update(schema.verification)
      .set({ value: JSON.stringify({ ...stored, attempts }), updatedAt: new Date() })
      .where(eq(schema.verification.id, row.id))
    return { ok: false, message: 'That code is not right.', code: 'invalid_code' }
  })
}

/**
 * Step two: checks the emailed code and, if it is right, resets the
 * organization. The only way to `resetOrganizationData`.
 */
export async function confirmOrganizationReset(input: {
  organizationId: string
  userId: string
  code: string
  actor: Actor
  context?: RequestContext
}): Promise<OrganizationResetResult> {
  await limit(`code:${input.userId}`, 'auth')
  await assertMayReset(input.organizationId, input.userId)

  const result = await checkCode(identifierFor(input.organizationId, input.userId), input.code.replace(/\s+/g, ''))
  if (!result.ok) throw new DomainError(result.message, result.code, 'code')

  const headers = input.context?.headers
  return resetOrganizationData({
    organizationId: input.organizationId,
    actor: input.actor,
    ipAddress: headers?.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
    userAgent: headers?.get('user-agent') ?? undefined,
  })
}
