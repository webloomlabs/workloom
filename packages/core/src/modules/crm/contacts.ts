import { and, desc, eq, ilike, isNull, lt, or, schema, sql } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from './companies.ts'
import {
  actingUserId,
  assertMember,
  contains,
  optionalEmail,
  optionalText,
  pageInput,
  pageOutput,
  paginate,
  provided,
  queryFlag,
  refuseArchived,
  requiredText,
  searchInput,
  withDuplicateEmailCheck,
} from './shared.ts'

export const contactOutput = z.object({
  id: z.uuid(),
  companyId: z.uuid().nullable(),
  /** Denormalised for display; `companyId` is the reference. */
  companyName: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  /** First and last name joined, for display. */
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  jobTitle: z.string().nullable(),
  ownerId: z.uuid().nullable(),
  lastActivityAt: z.date().nullable(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type Contact = z.infer<typeof contactOutput>
type ContactRow = typeof schema.contacts.$inferSelect

const columns = {
  contact: schema.contacts,
  companyName: schema.companies.name,
}

function present({ contact, companyName }: { contact: ContactRow; companyName: string | null }): Contact {
  return {
    id: contact.id,
    companyId: contact.companyId,
    companyName,
    firstName: contact.firstName,
    lastName: contact.lastName,
    fullName: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
    email: contact.email,
    phone: contact.phone,
    jobTitle: contact.jobTitle,
    ownerId: contact.ownerId,
    lastActivityAt: contact.lastActivityAt,
    archivedAt: contact.archivedAt,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  }
}

function selectContacts(ctx: ActorContext) {
  return ctx.tx
    .select(columns)
    .from(schema.contacts)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.contacts.companyId))
}

export async function getContact(ctx: ActorContext, id: string): Promise<Contact> {
  const [row] = await selectContacts(ctx).where(eq(schema.contacts.id, id)).limit(1)
  if (!row) throw new NotFoundError('Contact', id)
  return present(row)
}

export async function loadContact(ctx: ActorContext, id: string, options: { lock?: boolean } = {}) {
  const query = ctx.tx.select().from(schema.contacts).where(eq(schema.contacts.id, id)).limit(1)
  const [row] = options.lock ? await query.for('update') : await query
  if (!row) throw new NotFoundError('Contact', id)
  return row
}

const details = {
  lastName: optionalText(100),
  email: optionalEmail,
  phone: optionalText(50),
  jobTitle: optionalText(100),
}

export const contactList = defineProcedure({
  name: 'contact.list',
  summary: 'Contacts, newest first',
  permission: 'contact:read',
  readOnly: true,
  input: z.object({
    q: searchInput,
    companyId: z.uuid().optional(),
    includeArchived: queryFlag,
    ...pageInput,
  }),
  output: pageOutput(contactOutput),
  http: { method: 'GET', path: '/contacts' },
  async handler(ctx, input) {
    const c = schema.contacts
    const rows = await selectContacts(ctx)
      .where(
        and(
          input.includeArchived ? undefined : isNull(c.archivedAt),
          input.companyId ? eq(c.companyId, input.companyId) : undefined,
          input.q
            ? or(
                ilike(sql`${c.firstName} || ' ' || coalesce(${c.lastName}, '')`, contains(input.q)),
                ilike(c.email, contains(input.q)),
              )
            : undefined,
          input.cursor ? lt(c.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(c.id))
      .limit(input.limit + 1)
    return paginate(rows.map(present), input.limit)
  },
})

export const contactGet = defineProcedure({
  name: 'contact.get',
  summary: 'One contact, with its company name',
  permission: 'contact:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: contactOutput,
  http: { method: 'GET', path: '/contacts/{id}' },
  async handler(ctx, input) {
    return getContact(ctx, input.id)
  },
})

/** Writes a contact and announces it. Shared with lead conversion. */
export async function insertContact(
  ctx: ActorContext,
  values: Omit<typeof schema.contacts.$inferInsert, 'id' | 'organizationId'>,
): Promise<Contact> {
  const id = newId()
  await withDuplicateEmailCheck(() =>
    ctx.tx.insert(schema.contacts).values({
      ...values,
      id,
      organizationId: ctx.organizationId,
      createdBy: actingUserId(ctx),
    }),
  )
  const contact = await getContact(ctx, id)
  await ctx.audit({ action: 'contact.created', entityType: 'contact', entityId: id, entityLabel: contact.fullName })
  await ctx.emit('contact.created', contact)
  return contact
}

async function assertCompanyUsable(ctx: ActorContext, companyId: string | null | undefined) {
  if (!companyId) return
  refuseArchived(await loadCompany(ctx, companyId), 'company')
}

export const contactCreate = defineProcedure({
  name: 'contact.create',
  summary: 'Add a contact',
  permission: 'contact:create',
  input: z.object({
    firstName: requiredText(100, 'First name'),
    ...details,
    companyId: z.uuid().nullish(),
    ownerId: z.uuid().nullish(),
  }),
  output: contactOutput,
  http: { method: 'POST', path: '/contacts', successStatus: 201 },
  emits: ['contact.created'],
  async handler(ctx, input) {
    await assertCompanyUsable(ctx, input.companyId)
    const ownerId = input.ownerId === undefined ? actingUserId(ctx) : input.ownerId
    await assertMember(ctx, ownerId)
    return insertContact(ctx, { ...input, ownerId })
  },
})

export const contactUpdate = defineProcedure({
  name: 'contact.update',
  summary: 'Change a contact',
  permission: 'contact:update',
  input: z.object({
    id: z.uuid(),
    firstName: requiredText(100, 'First name').optional(),
    ...details,
    companyId: z.uuid().nullish(),
    ownerId: z.uuid().nullish(),
  }),
  output: contactOutput,
  http: { method: 'PATCH', path: '/contacts/{id}' },
  emits: ['contact.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadContact(ctx, id, { lock: true })
    const patch = provided(fields)
    if (patch.companyId && patch.companyId !== before.companyId) await assertCompanyUsable(ctx, patch.companyId)
    if (patch.ownerId) await assertMember(ctx, patch.ownerId)

    const changes = diff(before as Record<string, unknown>, patch)
    if (!changes) return getContact(ctx, id)

    await withDuplicateEmailCheck(() =>
      ctx.tx.update(schema.contacts).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.contacts.id, id)),
    )
    const contact = await getContact(ctx, id)
    await ctx.audit({ action: 'contact.updated', entityType: 'contact', entityId: id, entityLabel: contact.fullName, changes })
    await ctx.emit('contact.updated', contact)
    return contact
  },
})

export const contactArchive = defineProcedure({
  name: 'contact.archive',
  summary: 'Archive a contact. It is hidden from lists but keeps its history.',
  permission: 'contact:archive',
  input: z.object({ id: z.uuid() }),
  output: contactOutput,
  http: { method: 'DELETE', path: '/contacts/{id}' },
  emits: ['contact.archived'],
  async handler(ctx, input) {
    const before = await loadContact(ctx, input.id, { lock: true })
    if (before.archivedAt) return getContact(ctx, before.id)
    await ctx.tx
      .update(schema.contacts)
      .set({ archivedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(schema.contacts.id, before.id))
    const contact = await getContact(ctx, before.id)
    await ctx.audit({ action: 'contact.archived', entityType: 'contact', entityId: before.id, entityLabel: contact.fullName })
    await ctx.emit('contact.archived', contact)
    return contact
  },
})

export const contactRestore = defineProcedure({
  name: 'contact.restore',
  summary: 'Restore an archived contact',
  permission: 'contact:archive',
  input: z.object({ id: z.uuid() }),
  output: contactOutput,
  http: { method: 'POST', path: '/contacts/{id}/restore' },
  emits: ['contact.restored'],
  async handler(ctx, input) {
    const before = await loadContact(ctx, input.id, { lock: true })
    if (!before.archivedAt) return getContact(ctx, before.id)
    // Restoring can collide with a live contact created since with the same email.
    await withDuplicateEmailCheck(() =>
      ctx.tx
        .update(schema.contacts)
        .set({ archivedAt: null, updatedAt: ctx.now })
        .where(eq(schema.contacts.id, before.id)),
    )
    const contact = await getContact(ctx, before.id)
    await ctx.audit({ action: 'contact.restored', entityType: 'contact', entityId: before.id, entityLabel: contact.fullName })
    await ctx.emit('contact.restored', contact)
    return contact
  },
})
