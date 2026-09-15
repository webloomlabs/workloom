import { timestamp, uuid } from 'drizzle-orm/pg-core'
import { organization } from './auth.ts'

/**
 * The tenant column, spread into every domain table.
 *
 * Child tables carry it too, even where it is derivable from a parent. That
 * redundancy is deliberate: row-level security policies filter locally rather
 * than joining upward, and it allows composite foreign keys of the form
 * `(organization_id, parent_id)` which make cross-tenant parenting impossible
 * at the database level rather than merely unlikely.
 */
export const tenantColumn = {
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
}

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}
