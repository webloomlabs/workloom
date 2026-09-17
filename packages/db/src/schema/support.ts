import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn, timestamps } from './columns.ts'
import { companies, contacts } from './crm.ts'
import { projects } from './projects.ts'

/**
 * Support: what a client asks for after the work has shipped.
 *
 * A ticket is a request with a clock on it. The two due timestamps are written
 * once, when the ticket is created, from the service levels that applied at
 * that moment -- the client's maintenance plan, or the defaults for the
 * priority. A plan renegotiated next quarter does not move the target an
 * answered ticket was measured against, for the same reason a tax rate edited
 * next year does not change what an invoice said.
 *
 * `first_responded_at` and `resolved_at` are stamps, not statuses: whether a
 * ticket met its target is a comparison between what was promised and what
 * happened, and both halves have to be stored for the answer to survive.
 */

export const TICKET_TYPES = ['bug', 'incident', 'question', 'feature_request', 'change_request', 'other'] as const
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export const TICKET_STATUSES = ['open', 'in_progress', 'waiting_on_client', 'resolved', 'closed'] as const

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** Human reference, allocated from the same gapless per-organization sequence documents use. */
    number: text('number').notNull(),
    /** The client. Null for internal work the agency raises against itself. */
    companyId: uuid('company_id'),
    /** Who reported it, where that is a person on the client's side. */
    contactId: uuid('contact_id'),
    /** The project the request is against, where there is one. */
    projectId: uuid('project_id'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    type: text('type').notNull().default('question'),
    priority: text('priority').notNull().default('normal'),
    status: text('status').notNull().default('open'),
    assigneeId: uuid('assignee_id').references(() => user.id, { onDelete: 'set null' }),

    /** What was promised when the ticket arrived. Null when no service level applied. */
    firstResponseDueAt: timestamp('first_response_due_at', { withTimezone: true }),
    resolutionDueAt: timestamp('resolution_due_at', { withTimezone: true }),
    /** When someone first replied where the client could see it. */
    firstRespondedAt: timestamp('first_responded_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('tickets_organization_id_id_key').on(t.organizationId, t.id),
    uniqueIndex('tickets_organization_number_key').on(t.organizationId, t.number),
    index('tickets_organization_status_idx').on(t.organizationId, t.status),
    index('tickets_organization_company_idx').on(t.organizationId, t.companyId),
    index('tickets_organization_assignee_idx').on(t.organizationId, t.assigneeId),
    foreignKey({
      name: 'tickets_company_fk',
      columns: [t.organizationId, t.companyId],
      foreignColumns: [companies.organizationId, companies.id],
    }),
    foreignKey({
      name: 'tickets_contact_fk',
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
    foreignKey({
      name: 'tickets_project_fk',
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    check('tickets_type_check', sql`${t.type} in ${oneOf(TICKET_TYPES)}`),
    check('tickets_priority_check', sql`${t.priority} in ${oneOf(TICKET_PRIORITIES)}`),
    check('tickets_status_check', sql`${t.status} in ${oneOf(TICKET_STATUSES)}`),
    // The stamps and the status say the same thing, or the row is a lie about
    // what happened -- and the SLA report reads both.
    check(
      'tickets_resolved_check',
      sql`(${t.status} in ('resolved', 'closed')) = (${t.resolvedAt} is not null)`,
    ),
    check('tickets_closed_check', sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`),
  ],
)

/**
 * The conversation on a ticket.
 *
 * `internal` is the difference between a note to the team and a reply to the
 * client: only a message that is not internal counts as the first response,
 * and only a message that is not internal will reach the client portal.
 */
export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    ticketId: uuid('ticket_id').notNull(),
    authorId: uuid('author_id').references(() => user.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    internal: boolean('internal').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('ticket_messages_organization_id_id_key').on(t.organizationId, t.id),
    index('ticket_messages_organization_ticket_idx').on(t.organizationId, t.ticketId),
    foreignKey({
      name: 'ticket_messages_ticket_fk',
      columns: [t.organizationId, t.ticketId],
      foreignColumns: [tickets.organizationId, tickets.id],
    }).onDelete('cascade'),
  ],
)
