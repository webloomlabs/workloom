import { DomainError, newId, type Actor, type Role } from '@workloom/core'
// The auth tables are not tenant-scoped, so this module is one of the few
// permitted to use the unscoped client. See docs/architecture.md.
import { count, db, eq, schema, sql, type TenantTransaction } from '@workloom/db'
import { auth } from './auth.ts'
import { recordAuthEvent } from './audit-hooks.ts'

/**
 * Creating accounts and organizations without a session.
 *
 * A single-tenant installation has no public sign-up, so the two moments that
 * would normally go through Better Auth's own endpoints -- the first
 * administrator signing up, and a colleague accepting an invitation -- have to
 * happen some other way. Both end here.
 *
 * Nothing in this module authorises anything. `completeSetup` refuses once the
 * installation has an organization, and that is the whole of its protection;
 * `provisionMember` has none at all and trusts its caller. Callers are
 * expected to have established who is asking first, which is why there are
 * exactly two of them and both are named in docs/authentication.md.
 *
 * The rows are written with Drizzle rather than through Better Auth's internal
 * adapter. The shape of a credential account -- provider `credential`, the
 * account id equal to the user id, the password column holding a hash and
 * never a password -- is small and stable; reaching into a library's internals
 * to write it would not be.
 */

/** Advisory lock id for setup. Arbitrary, but must not collide with migrations. */
const SETUP_LOCK = 2_026_091_701

export type NewAccount = {
  name: string
  email: string
  password: string
}

/**
 * Has this installation been set up?
 *
 * The question is whether any account exists, not whether any organization
 * does. Setup is the one unauthenticated way to create an administrator, so
 * what closes it has to be something that cannot be undone from inside the
 * product. An owner who deletes their organization would otherwise reopen the
 * door for whoever reaches the URL next; with this test they lock themselves
 * out instead, which is the better of the two failures.
 *
 * `completeSetup` writes the account and the organization in one transaction,
 * so "an account exists" and "an organization exists" only ever disagree
 * after such a deletion, or after MULTI_TENANT was turned off on an
 * installation that already had people in it. Both should find setup closed.
 */
export async function isInstalled(): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(schema.user)
  return (row?.n ?? 0) > 0
}

async function hashPassword(password: string): Promise<string> {
  const context = await auth.$context
  const { minPasswordLength, maxPasswordLength } = context.password.config
  if (password.length < minPasswordLength) {
    throw new DomainError(`Use at least ${minPasswordLength} characters.`, 'password_too_short', 'password')
  }
  if (password.length > maxPasswordLength) {
    throw new DomainError(`Use at most ${maxPasswordLength} characters.`, 'password_too_long', 'password')
  }
  return context.password.hash(password)
}

/** A URL-safe slug from an organization name, with a short suffix for uniqueness. */
function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${base || 'organization'}-${crypto.randomUUID().slice(0, 6)}`
}

/**
 * Writes a user and their credential account.
 *
 * The address is taken as verified. In a single-tenant installation there is
 * nobody to verify it to: an administrator typed it, and the only thing
 * verification protects -- accepting an invitation to someone else's
 * organization -- does not exist here. Requiring it would instead make a
 * working mail server a condition of adding a colleague, which is exactly the
 * dependency a self-hosted install is trying to avoid.
 */
async function insertAccount(tx: TenantTransaction, person: NewAccount, passwordHash: string) {
  const email = person.email.trim().toLowerCase()

  const [existing] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1)
  if (existing) {
    throw new DomainError('An account already exists for that email address.', 'user_exists', 'email')
  }

  const userId = newId()
  await tx.insert(schema.user).values({
    id: userId,
    name: person.name.trim(),
    email,
    emailVerified: true,
  })
  await tx.insert(schema.account).values({
    id: newId(),
    userId,
    providerId: 'credential',
    accountId: userId,
    password: passwordHash,
  })

  return { id: userId, name: person.name.trim(), email }
}

/**
 * The first administrator and the organization they will work in.
 *
 * One transaction, because a user with no organization and an organization
 * with no owner are both states with no way forward through the UI. The
 * advisory lock makes two people submitting the setup form at the same moment
 * resolve into one winner and one "already set up" rather than two
 * organizations.
 */
export async function completeSetup(input: {
  admin: NewAccount
  organizationName: string
}): Promise<{ userId: string; organizationId: string }> {
  // Hashing is slow and does not belong inside the lock.
  const passwordHash = await hashPassword(input.admin.password)

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`)

    const [existing] = await tx.select({ n: count() }).from(schema.user)
    if ((existing?.n ?? 0) > 0) {
      throw new DomainError('This installation has already been set up.', 'already_installed')
    }

    const user = await insertAccount(tx, input.admin, passwordHash)

    const organizationId = newId()
    const name = input.organizationName.trim()
    await tx.insert(schema.organization).values({ id: organizationId, name, slug: slugify(name) })
    await tx
      .insert(schema.member)
      .values({ id: newId(), organizationId, userId: user.id, role: 'owner' })

    return { user, organizationId, name }
  })

  await recordAuthEvent({
    organizationId: result.organizationId,
    actor: { type: 'user', id: result.user.id, label: result.user.name || result.user.email },
    entry: {
      action: 'organization.created',
      entityType: 'organization',
      entityId: result.organizationId,
      entityLabel: result.name,
    },
  })

  return { userId: result.user.id, organizationId: result.organizationId }
}

/**
 * An account created by an administrator, already a member of their
 * organization.
 *
 * This replaces the invitation flow where there is no sign-up for an invitee
 * to complete. The administrator chooses the first password and passes it on
 * however they already communicate; the person changes it from the
 * forgot-password flow, or the administrator resets it again.
 *
 * The caller must have checked that the actor may do this -- see
 * `addMemberAction`.
 */
export async function provisionMember(input: {
  organizationId: string
  role: Role
  person: NewAccount
  /** For the audit entry: who asked for this account to exist. */
  createdBy: Actor
  context?: { headers?: Headers } | undefined
}): Promise<{ userId: string; memberId: string }> {
  const passwordHash = await hashPassword(input.person.password)

  const result = await db.transaction(async (tx) => {
    const user = await insertAccount(tx, input.person, passwordHash)
    const memberId = newId()
    await tx.insert(schema.member).values({
      id: memberId,
      organizationId: input.organizationId,
      userId: user.id,
      role: input.role,
    })
    return { user, memberId }
  })

  // The same entry and event an accepted invitation writes: from the
  // organization's point of view, and from a webhook subscriber's, someone
  // joined. How they got their password is not the interesting part.
  await recordAuthEvent({
    organizationId: input.organizationId,
    actor: input.createdBy,
    entry: {
      action: 'member.joined',
      entityType: 'member',
      entityId: result.memberId,
      entityLabel: result.user.email,
      changes: { role: { from: null, to: input.role } },
    },
    event: {
      type: 'member.joined',
      data: {
        memberId: result.memberId,
        userId: result.user.id,
        email: result.user.email,
        role: input.role,
      },
    },
    context: input.context,
  })

  return { userId: result.user.id, memberId: result.memberId }
}
