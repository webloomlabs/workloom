import { isRole, type Role } from '@workloom/core'
import { and, db, eq, schema } from '@workloom/db'

/**
 * A person's role in an organization right now, or undefined if they are not
 * a member. Every credential -- session, API key, OAuth grant -- is bounded by
 * this, read afresh on each use.
 */
export async function findMemberRole(userId: string, organizationId: string): Promise<Role | undefined> {
  const [row] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, organizationId)))
    .limit(1)
  return isRole(row?.role) ? row.role : undefined
}
