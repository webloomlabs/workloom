import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn, timestamps } from './columns.ts'
import { companies } from './crm.ts'
import { projects } from './projects.ts'

/**
 * Documents held against a client.
 *
 * Distinct from `attachments`, which are files posted into a project's or a
 * task's discussion. A document is filed rather than posted: it belongs to the
 * client, outlives the project it may mention, and is what someone goes looking
 * for two years later. Both keep their bytes in object storage and hand out
 * short-lived signed URLs after a permission check; neither stores a path a
 * caller could guess.
 */

export const CLIENT_DOCUMENT_CATEGORIES = [
  'contract',
  'proposal',
  'brief',
  'specification',
  'report',
  'policy',
  'identification',
  'other',
] as const

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

export const clientDocuments = pgTable(
  'client_documents',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    companyId: uuid('company_id').notNull(),
    /** The project it relates to, where it relates to one. */
    projectId: uuid('project_id'),
    title: text('title').notNull(),
    category: text('category').notNull().default('other'),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Generated, never derived from the filename. */
    storageKey: text('storage_key').notNull(),
    /** Marks what a client may see. The portal that reads it is Phase 2. */
    clientVisible: boolean('client_visible').notNull().default(false),
    notes: text('notes'),
    uploadedBy: uuid('uploaded_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('client_documents_organization_id_id_key').on(t.organizationId, t.id),
    index('client_documents_organization_company_idx').on(t.organizationId, t.companyId, t.category),
    index('client_documents_organization_project_idx').on(t.organizationId, t.projectId),
    foreignKey({
      name: 'client_documents_company_fk',
      columns: [t.organizationId, t.companyId],
      foreignColumns: [companies.organizationId, companies.id],
    }),
    foreignKey({
      name: 'client_documents_project_fk',
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    check('client_documents_category_check', sql`${t.category} in ${oneOf(CLIENT_DOCUMENT_CATEGORIES)}`),
    check('client_documents_size_check', sql`${t.sizeBytes} > 0`),
  ],
)
