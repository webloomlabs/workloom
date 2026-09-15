import { and, eq, schema } from '@workloom/db'
import { z } from 'zod'
import { DomainError } from '../context.ts'
import { defineProcedure } from '../registry/index.ts'
import { ROLES } from '../permissions/roles.ts'

const meOutput = z.object({
  organization: z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    baseCurrency: z.string(),
    timezone: z.string(),
  }),
  actor: z.object({
    type: z.enum(['user', 'apiKey', 'system', 'job']),
    label: z.string(),
  }),
  role: z.enum(ROLES).nullable(),
  /** Sorted, so clients and snapshots are stable. */
  permissions: z.array(z.string()),
})

/**
 * Who am I, and what may I do here?
 *
 * The first thing any API consumer calls, and the cheapest way to confirm a
 * key works and carries the authority its owner expects.
 */
export const meGet = defineProcedure({
  name: 'me.get',
  summary: 'The current actor, organization, and effective permissions',
  // Any authenticated actor. This endpoint reports only what the caller
  // already is, and it is how a scoped API key discovers its own scope --
  // gating it behind a permission makes narrow keys undebuggable.
  permission: 'authenticated',
  readOnly: true,
  input: z.object({}),
  output: meOutput,
  http: { method: 'GET', path: '/me' },
  async handler(ctx) {
    const [org] = await ctx.tx
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        slug: schema.organization.slug,
        baseCurrency: schema.organization.baseCurrency,
        timezone: schema.organization.timezone,
      })
      .from(schema.organization)
      .where(eq(schema.organization.id, ctx.organizationId))
      .limit(1)

    if (!org) throw new Error('the acting organization no longer exists')

    return {
      organization: org,
      actor: { type: ctx.actor.type, label: ctx.actor.label },
      role: ctx.role,
      permissions: [...ctx.permissions].sort(),
    }
  },
})

export const memberList = defineProcedure({
  name: 'member.list',
  summary: 'People in this organization',
  permission: 'member:read',
  readOnly: true,
  input: z.object({}),
  output: z.object({
    data: z.array(
      z.object({
        id: z.uuid(),
        userId: z.uuid(),
        name: z.string(),
        email: z.email(),
        role: z.enum(ROLES),
        joinedAt: z.date(),
      }),
    ),
  }),
  http: { method: 'GET', path: '/members' },
  async handler(ctx) {
    /**
     * `member` and `user` are auth tables, so they are not covered by
     * row-level security -- the organization predicate here is doing real
     * work rather than duplicating a policy. This is one of the few places
     * that is true, which is why it is spelled out.
     */
    const rows = await ctx.tx
      .select({
        id: schema.member.id,
        userId: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        role: schema.member.role,
        joinedAt: schema.member.createdAt,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, ctx.organizationId))

    return { data: rows as never }
  },
})

export const memberRemove = defineProcedure({
  name: 'member.remove',
  summary: 'Remove someone from this organization',
  permission: 'member:remove',
  input: z.object({ userId: z.uuid() }),
  output: z.object({ removed: z.boolean() }),
  http: { method: 'DELETE', path: '/members/{userId}' },
  async handler(ctx, input) {
    const [existing] = await ctx.tx
      .select({ id: schema.member.id, role: schema.member.role })
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, ctx.organizationId),
          eq(schema.member.userId, input.userId),
        ),
      )
      .limit(1)

    // Absent and not-yours are the same answer on purpose: distinguishing
    // them would confirm that a user id exists somewhere in the system.
    if (!existing) return { removed: false }

    if (existing.role === 'owner') {
      const owners = await ctx.tx
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, ctx.organizationId),
            eq(schema.member.role, 'owner'),
          ),
        )
      // Losing the last owner would leave the organization unadministrable,
      // with no supported way back in.
      if (owners.length <= 1) {
        throw new DomainError(
          'Cannot remove the only owner of an organization. Make someone else an owner first.',
          'last_owner',
        )
      }
    }

    await ctx.tx.delete(schema.member).where(eq(schema.member.id, existing.id))
    await ctx.audit({
      action: 'member.removed',
      entityType: 'member',
      entityId: existing.id,
      changes: { role: { from: existing.role, to: null } },
    })

    return { removed: true }
  },
})
