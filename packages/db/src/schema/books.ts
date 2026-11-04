import { sql } from 'drizzle-orm'
import { bigint, check, date, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn } from './columns.ts'

/**
 * Closing a year (S20): the income tax packs built from it, and the daily seals
 * that make the audit log tamper-evident.
 */

export const TAX_PACK_STATUSES = ['pending', 'ready', 'failed'] as const

/** A year's books, zipped for whoever prepares the income tax return. Built by the worker. */
export const taxPacks = pgTable(
  'tax_packs',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** The financial year: first and last day, and its name ("2025/26"). */
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    label: text('label').notNull(),
    status: text('status').notNull().default('pending'),
    storageKey: text('storage_key'),
    sha256: text('sha256'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** The headline figures, so the page can show them without opening the zip. */
    summary: jsonb('summary'),
    warnings: jsonb('warnings'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    requestedBy: uuid('requested_by').references(() => user.id, { onDelete: 'set null' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    unique('tax_packs_organization_id_id_key').on(t.organizationId, t.id),
    index('tax_packs_organization_status_idx').on(t.organizationId, t.status),
    check('tax_packs_status_check', sql`${t.status} in ('pending', 'ready', 'failed')`),
    check('tax_packs_period_check', sql`${t.periodStart} <= ${t.periodEnd}`),
    check('tax_packs_ready_check', sql`${t.status} <> 'ready' or (${t.storageKey} is not null and ${t.sha256} is not null)`),
  ],
)

/**
 * One day of the audit log, sealed: a SHA-256 over that day's entries and the
 * previous day's seal. Rewriting any sealed entry -- or removing one -- breaks
 * every seal after it, which `auditSeal.verify` reports. Append-only, like the
 * log itself.
 */
export const auditSeals = pgTable(
  'audit_seals',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    day: date('day', { mode: 'string' }).notNull(),
    entries: integer('entries').notNull(),
    digest: text('digest').notNull(),
    previousDigest: text('previous_digest'),
    sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('audit_seals_organization_id_id_key').on(t.organizationId, t.id), unique('audit_seals_day_key').on(t.organizationId, t.day)],
)
