import { and, desc, eq, like, lt, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { defineProcedure } from '../registry/index.ts'

const filterInput = {
  entityType: z.string().max(64).optional(),
  entityId: z.uuid().optional(),
  /** A person: what they did, by hand or through a key. */
  actorId: z.uuid().optional(),
  /** An exact action (`invoice.sent`) or a family (`invoice.`). */
  action: z.string().max(64).optional(),
  source: z.enum(['web', 'api', 'telegram', 'mcp', 'worker', 'system']).optional(),
  /** Inclusive days, UTC. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}

type Filters = { [K in keyof typeof filterInput]?: z.infer<(typeof filterInput)[K]> }

function filtersFor(input: Filters): SQL | undefined {
  const a = schema.auditLogs
  const conditions = [
    input.entityType ? eq(a.entityType, input.entityType) : undefined,
    input.entityId ? eq(a.entityId, input.entityId) : undefined,
    input.actorId ? eq(a.actorId, input.actorId) : undefined,
    input.action ? (input.action.endsWith('.') ? like(a.action, `${input.action.replace(/[%_\\]/g, '')}%`) : eq(a.action, input.action)) : undefined,
    input.source ? eq(a.source, input.source) : undefined,
    input.from ? sql`${a.createdAt} >= ${input.from}::date` : undefined,
    input.to ? sql`${a.createdAt} < ${input.to}::date + 1` : undefined,
  ].filter((f) => f !== undefined)
  return conditions.length > 0 ? and(...conditions) : undefined
}

const entryColumns = {
  id: schema.auditLogs.id,
  action: schema.auditLogs.action,
  entityType: schema.auditLogs.entityType,
  entityId: schema.auditLogs.entityId,
  entityLabel: schema.auditLogs.entityLabel,
  actorType: schema.auditLogs.actorType,
  actorId: schema.auditLogs.actorId,
  actorLabel: schema.auditLogs.actorLabel,
  source: schema.auditLogs.source,
  changes: schema.auditLogs.changes,
  snapshot: schema.auditLogs.snapshot,
  ipAddress: schema.auditLogs.ipAddress,
  createdAt: schema.auditLogs.createdAt,
}

export const auditLogList = defineProcedure({
  name: 'auditLog.list',
  summary: 'Recent audited actions',
  permission: 'auditLog:read',
  readOnly: true,
  input: z.object({
    ...filterInput,
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
        actorId: z.uuid().nullable(),
        actorLabel: z.string().nullable(),
        source: z.string().nullable(),
        changes: z.unknown().nullable(),
        /** The whole record, for money records created or deleted. */
        snapshot: z.unknown().nullable(),
        ipAddress: z.string().nullable(),
        createdAt: z.date(),
      }),
    ),
    nextCursor: z.uuid().nullable(),
  }),
  http: { method: 'GET', path: '/audit-logs' },
  async handler(ctx, input) {
    const where = filtersFor(input)
    const rows = await ctx.tx
      .select(entryColumns)
      .from(schema.auditLogs)
      .where(input.cursor ? and(where, lt(schema.auditLogs.id, input.cursor)) : where)
      .orderBy(desc(schema.auditLogs.id))
      .limit(input.limit + 1)

    // Fetching one extra row is how we know whether another page exists
    // without a second COUNT query.
    const hasMore = rows.length > input.limit
    const data = hasMore ? rows.slice(0, input.limit) : rows

    return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null }
  },
})

const EXPORT_LIMIT = 50_000

function csvField(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value)
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export const auditLogExport = defineProcedure({
  name: 'auditLog.export',
  summary: 'The audit log as CSV, filtered as the list is, oldest first, up to 50,000 entries',
  permission: 'auditLog:read',
  readOnly: true,
  input: z.object(filterInput),
  output: z.object({ filename: z.string(), csv: z.string(), rows: z.number().int(), truncated: z.boolean() }),
  http: { method: 'GET', path: '/audit-logs/export' },
  rateLimit: 'expensive',
  async handler(ctx, input) {
    const rows = await ctx.tx.select(entryColumns).from(schema.auditLogs).where(filtersFor(input)).orderBy(schema.auditLogs.id).limit(EXPORT_LIMIT + 1)
    const truncated = rows.length > EXPORT_LIMIT
    const kept = truncated ? rows.slice(0, EXPORT_LIMIT) : rows
    const header = ['When (UTC)', 'Action', 'Record', 'Record id', 'Label', 'Actor type', 'Actor id', 'Actor', 'Source', 'IP address', 'Changes', 'Snapshot', 'Entry id']
    const lines = [header.join(',')]
    for (const r of kept) {
      lines.push([r.createdAt, r.action, r.entityType, r.entityId, r.entityLabel, r.actorType, r.actorId, r.actorLabel, r.source, r.ipAddress, r.changes, r.snapshot, r.id].map(csvField).join(','))
    }
    const day = ctx.now.toISOString().slice(0, 10)
    return { filename: `audit-log-${day}.csv`, csv: `\uFEFF${lines.join('\r\n')}\r\n`, rows: kept.length, truncated }
  },
})
