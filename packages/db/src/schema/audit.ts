import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantColumn } from './columns.ts'

/**
 * Audit log.
 *
 * Append-only. A migration revokes UPDATE and DELETE on this table from the
 * application role -- an audit log the application can rewrite is not an audit
 * log.
 *
 * Entries are written explicitly by services via `ctx.audit(...)`, inside the
 * caller's transaction, rather than by a wrapper that diffs rows before and
 * after. A diffing wrapper can only ever record `invoice.updated`, when what
 * happened was `invoice.sent` -- and intent is the entire point.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,

    /** Who acted: 'user' | 'api_key' | 'system' | 'job'. */
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    /** Denormalised for readability: the actor may later be deleted. */
    actorLabel: text('actor_label'),

    /** Intent, e.g. 'invoice.sent'. Matches the event catalogue where one exists. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    entityLabel: text('entity_label'),

    /** Only what changed: `{ field: { from, to } }`. */
    changes: jsonb('changes'),

    /** Correlates this entry with application logs and the API error envelope. */
    requestId: text('request_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_organization_id_id_idx').on(t.organizationId, t.id),
    index('audit_logs_organization_entity_idx').on(t.organizationId, t.entityType, t.entityId),
    index('audit_logs_organization_actor_idx').on(t.organizationId, t.actorId),
  ],
)
