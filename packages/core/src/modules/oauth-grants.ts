import { and, desc, eq, isNull, schema } from '@workloom/db'
import { z } from 'zod'
import { NotFoundError, type ActorContext } from '../context.ts'
import { defineProcedure } from '../registry/index.ts'

/**
 * Connected apps: the AI assistants and other OAuth clients people have
 * allowed to act for them.
 *
 * Anyone may connect an app -- a grant never exceeds its person's role -- so
 * anyone may see and revoke their own. Those who manage API keys see and
 * revoke everyone's, since a grant is an API key in all but name.
 */

const grantSummary = z.object({
  id: z.uuid(),
  clientName: z.string(),
  userId: z.uuid(),
  userName: z.string(),
  /** Null means everything the person may do. */
  scopes: z.array(z.string()).nullable(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
})

/** The person behind the actor: themselves, or the owner of the key or grant they act through. */
function personOf(ctx: ActorContext): string | null {
  if (ctx.actor.type === 'user') return ctx.actor.id
  if (ctx.actor.type === 'apiKey') return ctx.actor.userId
  return null
}

export const oauthGrantList = defineProcedure({
  name: 'oauthGrant.list',
  summary: 'Apps connected through OAuth, such as AI assistants',
  // Reports the caller's own connections; everyone's needs apiKey:read.
  permission: 'authenticated',
  readOnly: true,
  input: z.object({ includeRevoked: z.boolean().default(false) }),
  output: z.object({ data: z.array(grantSummary) }),
  http: { method: 'GET', path: '/oauth-grants' },
  async handler(ctx, input) {
    const person = personOf(ctx)
    const everyone = ctx.has('apiKey:read')
    if (!everyone && !person) return { data: [] }

    const rows = await ctx.tx
      .select({
        id: schema.oauthGrants.id,
        clientName: schema.oauthGrants.clientName,
        userId: schema.oauthGrants.userId,
        userName: schema.user.name,
        userEmail: schema.user.email,
        scopes: schema.oauthGrants.scopes,
        createdAt: schema.oauthGrants.createdAt,
        lastUsedAt: schema.oauthGrants.lastUsedAt,
        revokedAt: schema.oauthGrants.revokedAt,
      })
      .from(schema.oauthGrants)
      .innerJoin(schema.user, eq(schema.user.id, schema.oauthGrants.userId))
      .where(
        and(
          input.includeRevoked ? undefined : isNull(schema.oauthGrants.revokedAt),
          everyone ? undefined : eq(schema.oauthGrants.userId, person!),
        ),
      )
      .orderBy(desc(schema.oauthGrants.createdAt))

    return { data: rows.map(({ userEmail, ...row }) => ({ ...row, userName: row.userName || userEmail })) }
  },
})

export const oauthGrantRevoke = defineProcedure({
  name: 'oauthGrant.revoke',
  // Not offered to AI assistants: credential management stays with people.
  mcp: false,
  summary: 'Disconnect an app connected through OAuth. Your own, or anyone’s with apiKey:revoke.',
  // Every role holds organization:read, and anyone may connect an app, so
  // anyone may disconnect their own. The handler narrows it to that.
  permission: 'organization:read',
  input: z.object({ id: z.uuid() }),
  output: z.object({ revoked: z.boolean() }),
  http: { method: 'DELETE', path: '/oauth-grants/{id}' },
  emits: [],
  async handler(ctx, input) {
    const [existing] = await ctx.tx
      .select({ id: schema.oauthGrants.id, clientName: schema.oauthGrants.clientName, userId: schema.oauthGrants.userId })
      .from(schema.oauthGrants)
      .where(and(eq(schema.oauthGrants.id, input.id), isNull(schema.oauthGrants.revokedAt)))
      .limit(1)

    // Someone else's connection is "not found" to anyone who may not manage it.
    if (!existing || (existing.userId !== personOf(ctx) && !ctx.has('apiKey:revoke'))) {
      throw new NotFoundError('Connected app', input.id)
    }

    await ctx.tx.update(schema.oauthGrants).set({ revokedAt: ctx.now }).where(eq(schema.oauthGrants.id, existing.id))
    await ctx.tx
      .update(schema.oauthTokens)
      .set({ revokedAt: ctx.now })
      .where(and(eq(schema.oauthTokens.grantId, existing.id), isNull(schema.oauthTokens.revokedAt)))

    await ctx.audit({
      action: 'oauth_grant.revoked',
      entityType: 'oauth_grant',
      entityId: existing.id,
      entityLabel: existing.clientName,
    })

    return { revoked: true }
  },
})
