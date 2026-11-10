import { isRole } from '@workloom/core/permissions'
// The auth tables are not tenant-scoped; see docs/architecture.md.
import { and, db, eq, schema } from '@workloom/db'
import { APIError } from 'better-auth/api'

/**
 * Holds every role Better Auth writes to exactly one of Workloom's roles.
 *
 * Better Auth accepts a comma-separated list of roles and is inconsistent
 * about whitespace in it: its "only an owner may invite an owner" check splits
 * without trimming, while its "is the inviter an owner" check trims. A role
 * sent as "admin, owner" to the raw invite endpoint therefore passes the first
 * check, is stored as sent, and then counts as an owner for the second --
 * a path from admin to owner. Workloom never uses multiple roles, so the
 * simplest sound rule is to refuse anything that is not one exact role, at
 * every point where a role is granted.
 *
 * Workloom's own forms already restrict roles to the list; these hooks close
 * the raw `/api/auth/organization/*` endpoints, which are reachable directly.
 */

function assertSingleRole(role: unknown): void {
  if (!isRole(role)) {
    throw new APIError('BAD_REQUEST', { message: 'That is not a valid role.' })
  }
}

async function memberRole(organizationId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
    .limit(1)
  return row?.role ?? null
}

export const roleGuardHooks = {
  async beforeCreateInvitation(data: {
    invitation: { role: string; organizationId: string; inviterId: string }
  }) {
    assertSingleRole(data.invitation.role)
    // Better Auth checks this too, but against a role it has trimmed and
    // split; repeat it against the exact stored role so that a member row
    // written before this guard existed cannot pass as an owner.
    if (data.invitation.role === 'owner') {
      const inviterRole = await memberRole(data.invitation.organizationId, data.invitation.inviterId)
      if (inviterRole !== 'owner') {
        throw new APIError('FORBIDDEN', { message: 'Only an owner can invite another owner.' })
      }
    }
  },

  async beforeAcceptInvitation(data: { invitation: { role: string } }) {
    // Refuses an invitation created before this guard with a malformed role.
    assertSingleRole(data.invitation.role)
  },

  async beforeAddMember(data: { member: { role: string } }) {
    assertSingleRole(data.member.role)
  },

  async beforeUpdateMemberRole(data: { newRole: string }) {
    assertSingleRole(data.newRole)
  },
}
