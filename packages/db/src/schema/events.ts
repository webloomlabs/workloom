import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { isNull, sql } from 'drizzle-orm'
import { user } from './auth.ts'
import { tenantColumn } from './columns.ts'

/**
 * The outbox.
 *
 * `ctx.emit()` inserts here inside the caller's transaction, and there is no
 * other way to emit. That gives the one property that matters: if the change
 * committed, its event exists; if the transaction rolled back, it does not.
 * There is no window where a webhook announces something that did not happen,
 * or where something happened and was never announced.
 *
 * The worker publishes rows by fanning them out to matching webhook endpoints
 * and stamping `published_at`.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** e.g. `invoice.paid`. A public contract: add new types, never rename. */
    type: text('type').notNull(),
    /** Payload schema version, so a shape change can ship alongside the old one. */
    version: integer('version').notNull().default(1),
    /** `{ type, id, label }` of whoever caused it. */
    actor: jsonb('actor').notNull(),
    /** The REST representation of the entity, as documented in the OpenAPI spec. */
    data: jsonb('data').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    index('events_organization_id_id_idx').on(t.organizationId, t.id),
    // Only the backlog is ever scanned by the dispatcher; keep that index tiny.
    index('events_unpublished_idx').on(t.id).where(isNull(t.publishedAt)),
    unique('events_organization_id_id_key').on(t.organizationId, t.id),
  ],
)

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    url: text('url').notNull(),
    description: text('description'),
    /** Exact types (`invoice.paid`), families (`invoice.*`), or everything (`*`). */
    eventTypes: text('event_types').array().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Why the endpoint was switched off automatically, if it was. */
    disabledReason: text('disabled_reason'),

    /**
     * Encrypted with WORKLOOM_ENCRYPTION_KEY. Not hashed: signing a payload
     * needs the secret itself, so it has to be recoverable by the worker.
     */
    secretEncrypted: text('secret_encrypted').notNull(),
    /**
     * During rotation both secrets sign every delivery until this one expires,
     * so a receiver can switch to the new secret without dropping events.
     */
    previousSecretEncrypted: text('previous_secret_encrypted'),
    previousSecretExpiresAt: timestamp('previous_secret_expires_at', { withTimezone: true }),

    /** Deliveries that exhausted every retry, in a row. Reset by any success. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),

    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('webhook_endpoints_organization_id_id_idx').on(t.organizationId, t.id),
    unique('webhook_endpoints_organization_id_id_key').on(t.organizationId, t.id),
  ],
)

/**
 * One event, to one endpoint. This table is also the delivery queue: a row is
 * due when `status = 'pending'` and `next_attempt_at` has passed, and a worker
 * claims it by setting a short `locked_until` lease.
 *
 * Making the log and the queue the same thing means there is no second system
 * to reconcile -- what the delivery log shows is exactly what will happen next.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    endpointId: uuid('endpoint_id').notNull(),
    eventId: uuid('event_id').notNull(),
    /** Denormalised so the log can be filtered without joining the outbox. */
    eventType: text('event_type').notNull(),

    /** 'pending' | 'succeeded' | 'failed' */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /** A claimed delivery is invisible to other workers until this passes. */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),

    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    responseStatus: integer('response_status'),
    /** First 2 KB only: enough to debug, too little to become a data store. */
    responseBody: text('response_body'),
    error: text('error'),
    durationMs: integer('duration_ms'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('webhook_deliveries_organization_id_id_idx').on(t.organizationId, t.id),
    index('webhook_deliveries_endpoint_idx').on(t.organizationId, t.endpointId, t.id),
    // A literal, not eq(): eq() emits a bind parameter, which is invalid in a
    // partial-index predicate and fails the migration.
    index('webhook_deliveries_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    // Composite keys through the tenant column: a delivery cannot reference
    // another organization's endpoint or event, by construction.
    foreignKey({
      name: 'webhook_deliveries_endpoint_fk',
      columns: [t.organizationId, t.endpointId],
      foreignColumns: [webhookEndpoints.organizationId, webhookEndpoints.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'webhook_deliveries_event_fk',
      columns: [t.organizationId, t.eventId],
      foreignColumns: [events.organizationId, events.id],
    }).onDelete('cascade'),
  ],
)

/**
 * Idempotency keys for the public API.
 *
 * Written in the same transaction as the mutation they protect, so a key is
 * recorded if and only if its operation committed. A retried request whose
 * first attempt failed simply runs again; one whose first attempt succeeded
 * gets the original response back.
 *
 * Scoped by actor as well as organization. Two integrations in one
 * organization that happen to pick the same key string must not receive each
 * other's responses -- they may hold different permissions.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    ...tenantColumn,
    actorKey: text('actor_key').notNull(),
    key: text('key').notNull(),
    procedure: text('procedure').notNull(),
    /** SHA-256 of the procedure name and canonical input. */
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'idempotency_keys_pkey', columns: [t.organizationId, t.actorKey, t.key] })],
)
