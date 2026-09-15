import { and, desc, eq, lt, schema } from '@workloom/db'
import { z } from 'zod'
import { defineProcedure } from '../registry/index.ts'

export const auditLogList = defineProcedure({
  name: 'auditLog.list',
  summary: 'Recent audited actions',
  permission: 'auditLog:read',
  readOnly: true,
  input: z.object({
    entityType: z.string().max(64).optional(),
    entityId: z.uuid().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    /**
     * Keyset pagination on the UUIDv7 primary key. Ids sort chronologically,
     * so the cursor is both a position and a timestamp -- and unlike OFFSET
     * it does not slow down or skip rows as new entries arrive.
     */
    cursor: z.uuid().optional(),
  }),
  output: z.object({
    data: z.array(
      z.object({
        id: z.uuid(),
        action: z.string(),
        entityType: z.string(),
        entityId: z.uuid().nullable(),
        entityLabel: z.string().nullable(),
        actorType: z.string(),
        actorLabel: z.string().nullable(),
        changes: z.unknown().nullable(),
        createdAt: z.date(),
      }),
    ),
    nextCursor: z.uuid().nullable(),
  }),
  http: { method: 'GET', path: '/audit-logs' },
  async handler(ctx, input) {
    const filters = [
      input.entityType ? eq(schema.auditLogs.entityType, input.entityType) : undefined,
      input.entityId ? eq(schema.auditLogs.entityId, input.entityId) : undefined,
      input.cursor ? lt(schema.auditLogs.id, input.cursor) : undefined,
    ].filter((f) => f !== undefined)

    const rows = await ctx.tx
      .select({
        id: schema.auditLogs.id,
        action: schema.auditLogs.action,
        entityType: schema.auditLogs.entityType,
        entityId: schema.auditLogs.entityId,
        entityLabel: schema.auditLogs.entityLabel,
        actorType: schema.auditLogs.actorType,
        actorLabel: schema.auditLogs.actorLabel,
        changes: schema.auditLogs.changes,
        createdAt: schema.auditLogs.createdAt,
      })
      .from(schema.auditLogs)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(schema.auditLogs.id))
      .limit(input.limit + 1)

    // Fetching one extra row is how we know whether another page exists
    // without a second COUNT query.
    const hasMore = rows.length > input.limit
    const data = hasMore ? rows.slice(0, input.limit) : rows

    return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null }
  },
})
