import { and, count, desc, eq, ilike, isNotNull, isNull, lt, or, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from '../crm/companies.ts'
import { loadContact } from '../crm/contacts.ts'
import {
  actingUserId,
  assertMember,
  contains,
  pageInput,
  pageOutput,
  paginate,
  provided,
  queryFlag,
  requiredText,
  searchInput,
} from '../crm/shared.ts'
import { issueNumber } from '../finance/numbering.ts'
import { loadProject } from '../projects/projects.ts'
import { dueAt, serviceLevelFor, slaState, type SlaState } from './sla.ts'

/**
 * Support tickets.
 *
 * What a client asks for once the project is over: a bug, an incident, a
 * question, a small change. A ticket is a request with two clocks on it -- see
 * ./sla.ts -- and a conversation attached.
 *
 * The status is the ticket's own state, not the clocks': `waiting_on_client`
 * says the agency is not the one holding it up, but it does not stop the
 * resolution target, because from the client's side the thing still is not
 * fixed. Agencies that want a stopped clock there are asking for a different
 * promise, and that belongs in a plan's terms rather than in a hidden rule.
 */

type TicketRow = typeof schema.tickets.$inferSelect

const OPEN_STATUSES = ['open', 'in_progress', 'waiting_on_client'] as const

export const ticketOutput = z.object({
  id: z.uuid(),
  number: z.string(),
  title: z.string(),
  body: z.string(),
  type: z.enum(schema.TICKET_TYPES),
  priority: z.enum(schema.TICKET_PRIORITIES),
  status: z.enum(schema.TICKET_STATUSES),
  /** True while the ticket is neither resolved nor closed. */
  open: z.boolean(),
  companyId: z.uuid().nullable(),
  companyName: z.string().nullable(),
  contactId: z.uuid().nullable(),
  contactName: z.string().nullable(),
  projectId: z.uuid().nullable(),
  projectName: z.string().nullable(),
  assigneeId: z.uuid().nullable(),
  assigneeName: z.string().nullable(),
  /** What was promised when the ticket was raised. Null where nothing was. */
  firstResponseDueAt: z.date().nullable(),
  resolutionDueAt: z.date().nullable(),
  firstRespondedAt: z.date().nullable(),
  resolvedAt: z.date().nullable(),
  closedAt: z.date().nullable(),
  /** `none`, `due`, `met`, or `breached`, against the targets above. */
  responseState: z.enum(['none', 'due', 'met', 'breached']),
  resolutionState: z.enum(['none', 'due', 'met', 'breached']),
  messageCount: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type Ticket = z.infer<typeof ticketOutput>

type TicketJoin = {
  ticket: TicketRow
  companyName: string | null
  contactName: string | null
  projectName: string | null
  assigneeName: string | null
  messageCount: number
}

function presentTicket(row: TicketJoin, now: Date): Ticket {
  const t = row.ticket
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    body: t.body,
    type: t.type as Ticket['type'],
    priority: t.priority as Ticket['priority'],
    status: t.status as Ticket['status'],
    open: (OPEN_STATUSES as readonly string[]).includes(t.status),
    companyId: t.companyId,
    companyName: row.companyName,
    contactId: t.contactId,
    contactName: row.contactName,
    projectId: t.projectId,
    projectName: row.projectName,
    assigneeId: t.assigneeId,
    assigneeName: row.assigneeName,
    firstResponseDueAt: t.firstResponseDueAt,
    resolutionDueAt: t.resolutionDueAt,
    firstRespondedAt: t.firstRespondedAt,
    resolvedAt: t.resolvedAt,
    closedAt: t.closedAt,
    responseState: slaState(t.firstResponseDueAt, t.firstRespondedAt, now),
    resolutionState: slaState(t.resolutionDueAt, t.resolvedAt, now),
    messageCount: row.messageCount,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
}

function selectTickets(ctx: ActorContext) {
  const messages = ctx.tx
    .select({ ticketId: schema.ticketMessages.ticketId, n: count().as('n') })
    .from(schema.ticketMessages)
    .groupBy(schema.ticketMessages.ticketId)
    .as('ticket_message_counts')

  return ctx.tx
    .select({
      ticket: schema.tickets,
      companyName: schema.companies.name,
      contactName: sql<string | null>`nullif(trim(concat_ws(' ', ${schema.contacts.firstName}, ${schema.contacts.lastName})), '')`,
      projectName: schema.projects.name,
      assigneeName: schema.user.name,
      messageCount: sql<number>`coalesce(${messages.n}, 0)::int`,
    })
    .from(schema.tickets)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.tickets.companyId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.tickets.contactId))
    .leftJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
    .leftJoin(schema.user, eq(schema.user.id, schema.tickets.assigneeId))
    .leftJoin(messages, eq(messages.ticketId, schema.tickets.id))
}

export async function getTicket(ctx: ActorContext, id: string): Promise<Ticket> {
  const [row] = await selectTickets(ctx).where(eq(schema.tickets.id, id)).limit(1)
  if (!row) throw new NotFoundError('Ticket', id)
  return presentTicket(row, ctx.now)
}

export async function loadTicket(ctx: ActorContext, id: string, options: { lock?: boolean } = {}): Promise<TicketRow> {
  const query = ctx.tx.select().from(schema.tickets).where(eq(schema.tickets.id, id)).limit(1)
  const [row] = await (options.lock ? query.for('update') : query)
  if (!row) throw new NotFoundError('Ticket', id)
  return row
}

/** The links a ticket carries, checked to be the same client's. */
async function resolveTicketLinks(
  ctx: ActorContext,
  input: { companyId?: string | null | undefined; contactId?: string | null | undefined; projectId?: string | null | undefined },
  current: { companyId: string | null } = { companyId: null },
) {
  const companyId = input.companyId !== undefined ? input.companyId : current.companyId
  if (companyId) await loadCompany(ctx, companyId)
  if (input.contactId) {
    const contact = await loadContact(ctx, input.contactId)
    if (contact.companyId !== companyId) {
      throw new DomainError('That contact works for a different client.', 'contact_company_mismatch', 'contactId')
    }
  }
  if (input.projectId) {
    const project = await loadProject(ctx, input.projectId)
    if (companyId && project.companyId !== companyId) {
      throw new DomainError('That project is for a different client.', 'project_company_mismatch', 'projectId')
    }
  }
  return { companyId: companyId ?? null }
}

// Reads

export const ticketList = defineProcedure({
  name: 'ticket.list',
  summary: 'Tickets, newest first, filtered by status, priority, type, client, project, or assignee',
  permission: 'ticket:read',
  readOnly: true,
  input: z.object({
    status: z.enum(schema.TICKET_STATUSES).optional(),
    /** Everything not resolved or closed. Overrides `status` when both are given. */
    open: queryFlag,
    priority: z.enum(schema.TICKET_PRIORITIES).optional(),
    type: z.enum(schema.TICKET_TYPES).optional(),
    companyId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    assigneeId: z.uuid().optional(),
    /** Unassigned only. */
    unassigned: queryFlag,
    /** Only tickets that have missed a target they were given. */
    breached: queryFlag,
    /** Matches the number, the title, or the description. */
    q: searchInput,
    ...pageInput,
  }),
  output: pageOutput(ticketOutput),
  http: { method: 'GET', path: '/tickets' },
  async handler(ctx, input) {
    const t = schema.tickets
    if (input.companyId) await loadCompany(ctx, input.companyId)
    if (input.projectId) await loadProject(ctx, input.projectId)

    const conditions: Array<SQL | undefined> = [
      input.open ? sql`${t.status} in ('open', 'in_progress', 'waiting_on_client')` : input.status ? eq(t.status, input.status) : undefined,
      input.priority ? eq(t.priority, input.priority) : undefined,
      input.type ? eq(t.type, input.type) : undefined,
      input.companyId ? eq(t.companyId, input.companyId) : undefined,
      input.projectId ? eq(t.projectId, input.projectId) : undefined,
      input.assigneeId ? eq(t.assigneeId, input.assigneeId) : undefined,
      input.unassigned ? isNull(t.assigneeId) : undefined,
      // A target that has passed with nothing to show for it. Decided in SQL so
      // that "what is late" is a page of results, not a filter over one page.
      input.breached
        ? or(
            and(isNotNull(t.firstResponseDueAt), isNull(t.firstRespondedAt), lt(t.firstResponseDueAt, ctx.now)),
            and(isNotNull(t.resolutionDueAt), isNull(t.resolvedAt), lt(t.resolutionDueAt, ctx.now)),
            and(isNotNull(t.firstResponseDueAt), isNotNull(t.firstRespondedAt), sql`${t.firstRespondedAt} > ${t.firstResponseDueAt}`),
            and(isNotNull(t.resolutionDueAt), isNotNull(t.resolvedAt), sql`${t.resolvedAt} > ${t.resolutionDueAt}`),
          )
        : undefined,
      input.q ? or(ilike(t.number, contains(input.q)), ilike(t.title, contains(input.q)), ilike(t.body, contains(input.q))) : undefined,
      input.cursor ? lt(t.id, input.cursor) : undefined,
    ]
    const rows = await selectTickets(ctx).where(and(...conditions)).orderBy(desc(t.id)).limit(input.limit + 1)
    return paginate(
      rows.map((row) => presentTicket(row, ctx.now)),
      input.limit,
    )
  },
})

export const ticketGet = defineProcedure({
  name: 'ticket.get',
  summary: 'One ticket, with where its two clocks stand',
  permission: 'ticket:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: ticketOutput,
  http: { method: 'GET', path: '/tickets/{id}' },
  async handler(ctx, input) {
    return getTicket(ctx, input.id)
  },
})

// Writes

const ticketFields = {
  type: z.enum(schema.TICKET_TYPES).optional(),
  priority: z.enum(schema.TICKET_PRIORITIES).optional(),
  /** The client it is for. Null for the agency's own work. */
  companyId: z.uuid().nullish(),
  /** Who reported it, on the client's side. */
  contactId: z.uuid().nullish(),
  projectId: z.uuid().nullish(),
  assigneeId: z.uuid().nullish(),
}

export const ticketCreate = defineProcedure({
  name: 'ticket.create',
  summary: 'Raise a support ticket. Its response and resolution targets are set from the client\'s plan, or from the priority.',
  permission: 'ticket:create',
  input: z.object({
    title: requiredText(200, 'Title'),
    body: requiredText(20_000, 'Description'),
    ...ticketFields,
  }),
  output: ticketOutput,
  http: { method: 'POST', path: '/tickets', successStatus: 201 },
  emits: ['ticket.created'],
  async handler(ctx, input) {
    const { companyId } = await resolveTicketLinks(ctx, input)
    await assertMember(ctx, input.assigneeId)
    const priority = input.priority ?? 'normal'
    const level = await serviceLevelFor(ctx, companyId, priority)

    const id = newId()
    await ctx.tx.insert(schema.tickets).values({
      id,
      organizationId: ctx.organizationId,
      number: await issueNumber(ctx, 'ticket'),
      companyId,
      contactId: input.contactId ?? null,
      projectId: input.projectId ?? null,
      title: input.title,
      body: input.body,
      type: input.type ?? 'question',
      priority,
      status: 'open',
      assigneeId: input.assigneeId ?? null,
      firstResponseDueAt: dueAt(ctx.now, level.responseHours),
      resolutionDueAt: dueAt(ctx.now, level.resolutionHours),
      createdBy: actingUserId(ctx),
    })

    const ticket = await getTicket(ctx, id)
    await ctx.audit({ action: 'ticket.created', entityType: 'ticket', entityId: id, entityLabel: `${ticket.number} ${ticket.title}` })
    await ctx.emit('ticket.created', ticket)
    return ticket
  },
})

export const ticketUpdate = defineProcedure({
  name: 'ticket.update',
  summary: 'Change a ticket. Its targets stay as they were promised.',
  permission: 'ticket:update',
  input: z.object({
    id: z.uuid(),
    title: requiredText(200, 'Title').optional(),
    body: requiredText(20_000, 'Description').optional(),
    ...ticketFields,
  }),
  output: ticketOutput,
  http: { method: 'PATCH', path: '/tickets/{id}' },
  emits: ['ticket.updated', 'ticket.assigned'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadTicket(ctx, id, { lock: true })
    if (fields.assigneeId) await assertMember(ctx, fields.assigneeId)
    const links = await resolveTicketLinks(ctx, fields, before)

    const patch = { ...provided(fields), ...links } as Partial<TicketRow>
    const changes = diff(before as unknown as Record<string, unknown>, patch)
    if (!changes) return getTicket(ctx, id)

    await ctx.tx.update(schema.tickets).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.tickets.id, id))
    const ticket = await getTicket(ctx, id)
    await ctx.audit({ action: 'ticket.updated', entityType: 'ticket', entityId: id, entityLabel: `${ticket.number} ${ticket.title}`, changes })
    await ctx.emit('ticket.updated', ticket)
    // Assignment is what a notification integration listens for; it should not
    // have to diff two payloads to notice it.
    if (changes['assigneeId'] && ticket.assigneeId) await ctx.emit('ticket.assigned', ticket)
    return ticket
  },
})

/**
 * The status, and the stamps that follow from it.
 *
 * `resolved_at` and `closed_at` are what the database's own checks insist
 * match the status, and what the SLA report reads -- so they are set here, in
 * one place, rather than by whoever remembers.
 */
export const ticketChangeStatus = defineProcedure({
  name: 'ticket.changeStatus',
  summary: 'Move a ticket to another status, resolving, closing, or reopening it',
  permission: 'ticket:update',
  input: z.object({ id: z.uuid(), status: z.enum(schema.TICKET_STATUSES) }),
  output: ticketOutput,
  http: { method: 'POST', path: '/tickets/{id}/status' },
  emits: ['ticket.status_changed', 'ticket.resolved', 'ticket.closed', 'ticket.reopened'],
  async handler(ctx, input) {
    const before = await loadTicket(ctx, input.id, { lock: true })
    if (before.status === input.status) return getTicket(ctx, input.id)

    const resolving = input.status === 'resolved' || input.status === 'closed'
    await ctx.tx
      .update(schema.tickets)
      .set({
        status: input.status,
        // Reopening clears both stamps: the ticket was not, in fact, done.
        resolvedAt: resolving ? (before.resolvedAt ?? ctx.now) : null,
        closedAt: input.status === 'closed' ? (before.closedAt ?? ctx.now) : null,
        updatedAt: ctx.now,
      })
      .where(eq(schema.tickets.id, input.id))

    const ticket = await getTicket(ctx, input.id)
    const label = `${ticket.number} ${ticket.title}`
    await ctx.audit({
      action: 'ticket.status_changed',
      entityType: 'ticket',
      entityId: ticket.id,
      entityLabel: label,
      changes: { status: { from: before.status, to: input.status } },
    })
    await ctx.emit('ticket.status_changed', ticket)
    if (input.status === 'resolved') await ctx.emit('ticket.resolved', ticket)
    if (input.status === 'closed') await ctx.emit('ticket.closed', ticket)
    if (!resolving && before.resolvedAt) await ctx.emit('ticket.reopened', ticket)
    return ticket
  },
})

export const ticketDelete = defineProcedure({
  name: 'ticket.delete',
  summary: 'Delete a ticket and its messages',
  permission: 'ticket:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/tickets/{id}' },
  emits: ['ticket.deleted'],
  async handler(ctx, input) {
    const ticket = await getTicket(ctx, input.id)
    await ctx.tx.delete(schema.tickets).where(eq(schema.tickets.id, input.id))
    await ctx.audit({ action: 'ticket.deleted', entityType: 'ticket', entityId: ticket.id, entityLabel: `${ticket.number} ${ticket.title}` })
    await ctx.emit('ticket.deleted', ticket)
    return { deleted: true }
  },
})

// The conversation

export const ticketMessageOutput = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  authorId: z.uuid().nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  /** An internal note: never shown to the client, and never the first response. */
  internal: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const ticketMessageList = defineProcedure({
  name: 'ticketMessage.list',
  summary: 'The conversation on a ticket, oldest first',
  permission: 'ticket:read',
  readOnly: true,
  input: z.object({ ticketId: z.uuid(), ...pageInput }),
  output: pageOutput(ticketMessageOutput),
  http: { method: 'GET', path: '/tickets/{ticketId}/messages' },
  async handler(ctx, input) {
    await loadTicket(ctx, input.ticketId)
    const m = schema.ticketMessages
    const rows = await ctx.tx
      .select({ message: m, authorName: schema.user.name })
      .from(m)
      .leftJoin(schema.user, eq(schema.user.id, m.authorId))
      .where(and(eq(m.ticketId, input.ticketId), input.cursor ? sql`${m.id} > ${input.cursor}` : undefined))
      .orderBy(m.id)
      .limit(input.limit + 1)
    return paginate(
      rows.map((row) => ({ ...row.message, authorName: row.authorName })),
      input.limit,
    )
  },
})

export const ticketReply = defineProcedure({
  name: 'ticketMessage.create',
  summary: 'Reply on a ticket, or leave an internal note. The first reply that is not internal stops the response clock.',
  permission: 'ticket:update',
  input: z.object({
    ticketId: z.uuid(),
    body: requiredText(20_000, 'Message'),
    internal: z.boolean().optional(),
    /** Moves the ticket on in the same step, which is what replying usually means. */
    status: z.enum(schema.TICKET_STATUSES).optional(),
  }),
  output: ticketMessageOutput,
  http: { method: 'POST', path: '/tickets/{ticketId}/messages', successStatus: 201 },
  emits: ['ticket.replied', 'ticket.status_changed'],
  async handler(ctx, input) {
    const ticket = await loadTicket(ctx, input.ticketId, { lock: true })
    const id = newId()
    await ctx.tx.insert(schema.ticketMessages).values({
      id,
      organizationId: ctx.organizationId,
      ticketId: ticket.id,
      authorId: actingUserId(ctx),
      body: input.body,
      internal: input.internal ?? false,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    // `first_responded_at` is stamped by a trigger, so that every path that
    // inserts a message records it the same way. See migration 0020.

    if (input.status && input.status !== ticket.status) {
      const resolving = input.status === 'resolved' || input.status === 'closed'
      await ctx.tx
        .update(schema.tickets)
        .set({
          status: input.status,
          resolvedAt: resolving ? (ticket.resolvedAt ?? ctx.now) : null,
          closedAt: input.status === 'closed' ? (ticket.closedAt ?? ctx.now) : null,
          updatedAt: ctx.now,
        })
        .where(eq(schema.tickets.id, ticket.id))
    } else {
      await ctx.tx.update(schema.tickets).set({ updatedAt: ctx.now }).where(eq(schema.tickets.id, ticket.id))
    }

    const [row] = await ctx.tx
      .select({ message: schema.ticketMessages, authorName: schema.user.name })
      .from(schema.ticketMessages)
      .leftJoin(schema.user, eq(schema.user.id, schema.ticketMessages.authorId))
      .where(eq(schema.ticketMessages.id, id))
      .limit(1)
    const message = { ...row!.message, authorName: row!.authorName }

    await ctx.audit({
      action: input.internal ? 'ticket.note_added' : 'ticket.replied',
      entityType: 'ticket',
      entityId: ticket.id,
      entityLabel: `${ticket.number} ${ticket.title}`,
    })
    // An internal note is not an answer to anyone outside the agency, so it is
    // not announced as one.
    if (!message.internal) await ctx.emit('ticket.replied', { ticket: await getTicket(ctx, ticket.id), message })
    if (input.status && input.status !== ticket.status) {
      await ctx.emit('ticket.status_changed', await getTicket(ctx, ticket.id))
    }
    return message
  },
})

/** Open tickets for a client, for the client view's Support tab. */
export async function countOpenTickets(ctx: ActorContext, companyId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ n: count() })
    .from(schema.tickets)
    .where(and(eq(schema.tickets.companyId, companyId), sql`${schema.tickets.status} in ('open', 'in_progress', 'waiting_on_client')`))
  return row?.n ?? 0
}

export type { SlaState }
