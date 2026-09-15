import { and, desc, eq, isNull, schema } from '@workloom/db'
import { z } from 'zod'
import { generateApiKey } from '../api-key-crypto.ts'
import { DomainError, NotFoundError } from '../context.ts'
import { newId } from '../ids.ts'
import { isPermission } from '../permissions/statements.ts'
import { defineProcedure } from '../registry/index.ts'

const apiKeySummary = z.object({
  id: z.uuid(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()).nullable(),
  lastUsedAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
})

export const apiKeyList = defineProcedure({
  name: 'apiKey.list',
  summary: 'API keys in this organization',
  permission: 'apiKey:read',
  readOnly: true,
  input: z.object({ includeRevoked: z.boolean().default(false) }),
  output: z.object({ data: z.array(apiKeySummary) }),
  http: { method: 'GET', path: '/api-keys' },
  async handler(ctx, input) {
    const rows = await ctx.tx
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        keyPrefix: schema.apiKeys.keyPrefix,
        scopes: schema.apiKeys.scopes,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        expiresAt: schema.apiKeys.expiresAt,
        revokedAt: schema.apiKeys.revokedAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .where(input.includeRevoked ? undefined : isNull(schema.apiKeys.revokedAt))
      .orderBy(desc(schema.apiKeys.createdAt))

    // The secret is absent by construction -- it was never stored.
    return { data: rows }
  },
})

export const apiKeyCreate = defineProcedure({
  name: 'apiKey.create',
  summary: 'Issue an API key',
  permission: 'apiKey:create',
  input: z.object({
    name: z.string().min(1).max(100),
    /**
     * Omit for "everything the owner may do". Scopes only ever narrow: an
     * unknown or over-reaching scope is dropped at authentication time, not
     * granted.
     */
    scopes: z.array(z.string()).nullish(),
    expiresAt: z.coerce.date().nullish(),
  }),
  output: z.object({
    key: apiKeySummary,
    /**
     * Shown once. There is no endpoint that can return it again, because it
     * is not stored -- only its digest is.
     */
    secret: z.string(),
  }),
  http: { method: 'POST', path: '/api-keys', successStatus: 201 },
  async handler(ctx, input) {
    if (ctx.actor.type !== 'user') {
      // Otherwise a key could mint further keys, outliving its owner's
      // session and turning a single leak into a permanent foothold.
      throw new DomainError('API keys can only be issued by a signed-in user.', 'user_required')
    }

    const unknown = (input.scopes ?? []).filter((s) => !isPermission(s))
    if (unknown.length > 0) {
      throw new DomainError(
        `Unknown permissions requested: ${unknown.join(', ')}`,
        'unknown_scope',
        'scopes',
      )
    }

    if (input.expiresAt && input.expiresAt <= ctx.now) {
      throw new DomainError('The expiry date must be in the future.', 'expiry_in_past', 'expiresAt')
    }

    const generated = generateApiKey()
    const [row] = await ctx.tx
      .insert(schema.apiKeys)
      .values({
        id: newId(),
        organizationId: ctx.organizationId,
        userId: ctx.actor.id,
        name: input.name,
        keyHash: generated.hash,
        keyPrefix: generated.displayPrefix,
        scopes: input.scopes ?? null,
        expiresAt: input.expiresAt ?? null,
        createdBy: ctx.actor.id,
      })
      .returning()

    await ctx.audit({
      action: 'api_key.created',
      entityType: 'api_key',
      entityId: row!.id,
      entityLabel: input.name,
    })

    return { key: row!, secret: generated.secret }
  },
})

export const apiKeyRevoke = defineProcedure({
  name: 'apiKey.revoke',
  summary: 'Revoke an API key',
  permission: 'apiKey:revoke',
  input: z.object({ id: z.uuid() }),
  output: z.object({ revoked: z.boolean() }),
  http: { method: 'DELETE', path: '/api-keys/{id}' },
  async handler(ctx, input) {
    const [existing] = await ctx.tx
      .select({ id: schema.apiKeys.id, name: schema.apiKeys.name })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.id, input.id), isNull(schema.apiKeys.revokedAt)))
      .limit(1)

    // Row-level security has already scoped this to the organization, so a
    // missing row means "not here" -- which is the same answer whether it
    // belongs to someone else or does not exist.
    if (!existing) throw new NotFoundError('API key', input.id)

    await ctx.tx
      .update(schema.apiKeys)
      .set({ revokedAt: ctx.now })
      .where(eq(schema.apiKeys.id, existing.id))

    await ctx.audit({
      action: 'api_key.revoked',
      entityType: 'api_key',
      entityId: existing.id,
      entityLabel: existing.name,
    })

    return { revoked: true }
  },
})
