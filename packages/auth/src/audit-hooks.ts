import {
  newId,
  writeAuditEntry,
  writeEvent,
  type Actor,
  type AuditEntry,
  type EventType,
} from '@workloom/core'
import { db, eq, schema, withTenant } from '@workloom/db'

/**
 * Audit entries for events that happen inside Better Auth.
 *
 * Domain procedures audit themselves through `ctx.audit`. Membership and
 * authentication changes happen in Better Auth's own endpoints, outside the
 * registry, so they are captured through its hooks instead -- otherwise the
 * most security-relevant events in the system (who joined, who was removed,
 * whose role changed) would be the ones missing from the log.
 *
 * These run AFTER Better Auth has committed, so the entry cannot share the
 * change's transaction the way `ctx.audit` does. A failed write is logged
 * loudly rather than thrown: an audit outage that locks every user out of the
 * product is worse than a gap in the log, and the gap is visible in the
 * server logs, correlated by request.
 */

type RequestContext = {
  headers?: Headers
  request?: Request
} | null | undefined

function requestMeta(context: RequestContext) {
  const headers = context?.headers ?? context?.request?.headers
  return {
    ipAddress: headers?.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
    userAgent: headers?.get('user-agent') ?? undefined,
  }
}

function userActor(user: { id: string; name?: string | null; email: string }): Actor {
  return { type: 'user', id: user.id, label: user.name || user.email }
}

export async function recordAuthEvent(options: {
  organizationId: string
  actor: Actor
  entry: AuditEntry
  /** The outbox event to publish alongside the audit entry, if any. */
  event?: { type: EventType; data: unknown }
  context?: RequestContext
}): Promise<void> {
  try {
    // One transaction, so the audit entry and the webhook event agree: either
    // both record the change or neither does.
    await withTenant(options.organizationId, async (tx) => {
      await writeAuditEntry(tx, {
        organizationId: options.organizationId,
        actor: options.actor,
        requestId: newId(),
        ...requestMeta(options.context),
        entry: options.entry,
      })
      if (options.event) {
        await writeEvent(tx, {
          organizationId: options.organizationId,
          actor: options.actor,
          type: options.event.type,
          data: options.event.data,
        })
      }
    })
  } catch (error) {
    console.error(
      `[audit] FAILED to record ${options.entry.action} for organization ` +
        `${options.organizationId}. The action itself succeeded.`,
      error,
    )
  }
}

type HookUser = { id: string; name?: string | null; email: string }
type HookOrg = { id: string; name: string }

export const organizationAuditHooks = {
  async afterCreateOrganization(data: { organization: HookOrg; user: HookUser }) {
    await recordAuthEvent({
      organizationId: data.organization.id,
      actor: userActor(data.user),
      entry: {
        action: 'organization.created',
        entityType: 'organization',
        entityId: data.organization.id,
        entityLabel: data.organization.name,
      },
    })
  },

  async afterCreateInvitation(data: {
    invitation: { id: string; email: string; role: string }
    inviter: HookUser
    organization: HookOrg
  }) {
    await recordAuthEvent({
      organizationId: data.organization.id,
      actor: userActor(data.inviter),
      entry: {
        action: 'member.invited',
        entityType: 'invitation',
        entityId: data.invitation.id,
        entityLabel: data.invitation.email,
        changes: { role: { from: null, to: data.invitation.role } },
      },
      event: {
        type: 'member.invited',
        data: { invitationId: data.invitation.id, email: data.invitation.email, role: data.invitation.role },
      },
    })
  },

  async afterAcceptInvitation(data: {
    member: { id: string; role: string }
    user: HookUser
    organization: HookOrg
  }) {
    await recordAuthEvent({
      organizationId: data.organization.id,
      actor: userActor(data.user),
      entry: {
        action: 'member.joined',
        entityType: 'member',
        entityId: data.member.id,
        entityLabel: data.user.email,
        changes: { role: { from: null, to: data.member.role } },
      },
      event: {
        type: 'member.joined',
        data: { memberId: data.member.id, userId: data.user.id, email: data.user.email, role: data.member.role },
      },
    })
  },

  async afterCancelInvitation(data: {
    invitation: { id: string; email: string }
    cancelledBy: HookUser
    organization: HookOrg
  }) {
    await recordAuthEvent({
      organizationId: data.organization.id,
      actor: userActor(data.cancelledBy),
      entry: {
        action: 'invitation.cancelled',
        entityType: 'invitation',
        entityId: data.invitation.id,
        entityLabel: data.invitation.email,
      },
      event: {
        type: 'invitation.cancelled',
        data: { invitationId: data.invitation.id, email: data.invitation.email },
      },
    })
  },

  async afterUpdateMemberRole(data: {
    member: { id: string; role: string }
    previousRole: string
    user: HookUser
    organization: HookOrg
  }) {
    // `user` here is the member whose role changed. Better Auth does not pass
    // the acting user to this hook, so the entry is attributed to the member
    // and the actor is recovered from the request in the server log.
    await recordAuthEvent({
      organizationId: data.organization.id,
      actor: userActor(data.user),
      entry: {
        action: 'member.role_changed',
        entityType: 'member',
        entityId: data.member.id,
        entityLabel: data.user.email,
        changes: { role: { from: data.previousRole, to: data.member.role } },
      },
      event: {
        type: 'member.role_changed',
        data: { memberId: data.member.id, userId: data.user.id, from: data.previousRole, to: data.member.role },
      },
    })
  },

  async afterRemoveMember(data: {
    member: { id: string; role: string }
    user: HookUser
    organization: HookOrg
  }) {
    await recordAuthEvent({
      organizationId: data.organization.id,
      actor: userActor(data.user),
      entry: {
        action: 'member.removed',
        entityType: 'member',
        entityId: data.member.id,
        entityLabel: data.user.email,
        changes: { role: { from: data.member.role, to: null } },
      },
      event: { type: 'member.removed', data: { userId: data.user.id, role: data.member.role } },
    })
  },
}

/**
 * Sign-ins.
 *
 * A session belongs to a user, not an organization, but the audit log is
 * per-organization. So a sign-in is recorded in every organization the person
 * belongs to: each agency sees when its own members accessed the system, and
 * none sees anything about the others.
 */
export async function recordSignIn(
  session: { userId: string },
  context: RequestContext,
): Promise<void> {
  const [user] = await db
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, session.userId))
    .limit(1)
  if (!user) return

  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, session.userId))

  await Promise.all(
    memberships.map((m) =>
      recordAuthEvent({
        organizationId: m.organizationId,
        actor: userActor(user),
        entry: { action: 'auth.signed_in', entityType: 'user', entityId: user.id, entityLabel: user.email },
        context,
      }),
    ),
  )
}
