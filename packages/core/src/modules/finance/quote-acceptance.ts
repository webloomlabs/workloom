import { and, eq, inArray, ne, schema } from '@workloom/db'
import { z } from 'zod'
import { DomainError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId, minorAmount, optionalText } from '../crm/shared.ts'
import { projectBillingStageCreate } from '../projects/billing-stages.ts'
import { loadProject, projectCreate, projectUpdate } from '../projects/projects.ts'
import { projectRevisionAccept, projectRevisionCreate, projectRevisionSend } from '../projects/revisions.ts'
import { billingScheduleChangeStatus, billingScheduleCreate } from './billing-schedules.ts'
import { percentInput } from './shared.ts'
import { quoteSplit } from './quote-split.ts'
import { getQuote, loadQuote, loadQuoteLines, quoteOutput, requireOpen } from './quotes.ts'

/**
 * Accepting a quote, and everything that follows from it.
 *
 * A quote is an offer; acceptance is the commercial commitment, and it should
 * carry into the work without anyone typing it again (US-07):
 *
 * - **Alternatives.** A quote in a group of options is one of several the
 *   client chose between: accepting it declines the others still open, and
 *   the group is decided. A partial unique index makes two accepted options
 *   impossible.
 * - **The project.** The quote's own, one named here, or one created now.
 * - **The one-time price.** The first quote accepted for a project sets its
 *   contract value. Every later one is scope added to it, and goes on the
 *   record the way any change does: as a revision, drafted, sent, and accepted.
 *   A revision already drafted against this quote is the one accepted.
 * - **What recurs.** Each recurring part becomes a billing schedule -- paused,
 *   so nothing bills until someone resumes it at go-live.
 * - **How it is billed.** Optionally, a plan: a deposit and the balance at
 *   launch, invoiced as a statement of the whole project.
 *
 * All in one transaction, through the same procedures a person would use, so
 * each step is checked, audited, and announced exactly as it would be alone.
 */

const STAGE_PRESETS = ['none', 'deposit_balance', 'halves'] as const

export const quoteAcceptOutput = quoteOutput.extend({
  /** What accepting it did. */
  applied: z.object({
    projectId: z.uuid().nullable(),
    /** How the one-time price reached the project: as its contract value, as a revision, or not at all. */
    contract: z.enum(['base', 'revision', 'none']),
    revisionId: z.uuid().nullable(),
    scheduleIds: z.array(z.uuid()),
    stageIds: z.array(z.uuid()),
    /** Alternatives declined because this one was chosen. */
    declinedQuoteIds: z.array(z.uuid()),
  }),
})

export const quoteAccept = defineProcedure({
  name: 'quote.accept',
  summary: 'Record that the client accepted a sent quote, and carry it into the project, its contract, and its billing',
  permission: 'quote:update',
  input: z.object({
    id: z.uuid(),
    /** The project it is for, when the quote does not already say. Must be the same client's. */
    projectId: z.uuid().nullish(),
    /** Start a project for it, from the quote. Ignored when it already has one. */
    createProject: z
      .object({
        name: optionalText(200),
        projectTypeId: z.uuid().nullish(),
        startDate: z.iso.date().nullish(),
        dueDate: z.iso.date().nullish(),
        ownerId: z.uuid().nullish(),
      })
      .optional(),
    /**
     * Whether the one-time price sets the contract (`base`), adds to it as a
     * revision (`addition`), or is left off the project (`none`). By default:
     * the base when the project has no contract value yet, otherwise an addition.
     */
    applyAs: z.enum(['base', 'addition', 'none']).optional(),
    /** Raise the project's budget by an addition's price as well. */
    raiseBudget: z.boolean().default(false),
    /** The day the recurring parts start billing. Defaults to the project's start, or today. */
    recurringStartOn: z.iso.date().nullish(),
    /** A billing plan to set up: a deposit and the balance as a statement at launch, or two halves. */
    stagePreset: z.enum(STAGE_PRESETS).default('none'),
    /** The deposit, for `deposit_balance`: a share of the contract, or an amount. */
    depositPercent: percentInput.nullish(),
    depositAmountMinor: minorAmount.nullish(),
  }),
  output: quoteAcceptOutput,
  http: { method: 'POST', path: '/quotes/{id}/accept' },
  emits: [
    'quote.accepted',
    'quote.declined',
    'project.created',
    'project_member.added',
    'project.updated',
    'project_revision.created',
    'project_revision.sent',
    'project_revision.accepted',
    'billing_schedule.created',
    'billing_schedule.status_changed',
    'project_billing_stage.created',
  ],
  async handler(ctx, input) {
    const quote = await loadQuote(ctx, input.id, { lock: true })
    await requireOpen(ctx, quote)

    // 1. Alternatives: this one is chosen, the others still open are not.
    const declinedQuoteIds = await decideGroup(ctx, quote)

    await ctx.tx.update(schema.quotes).set({ status: 'accepted', acceptedAt: ctx.now, updatedAt: ctx.now }).where(eq(schema.quotes.id, quote.id))
    await ctx.audit({
      action: 'quote.accepted',
      entityType: 'quote',
      entityId: quote.id,
      entityLabel: `${quote.number} ${quote.title}`,
      changes: { status: { from: 'sent', to: 'accepted' } },
    })

    // 2. The project.
    const projectId = await resolveProject(ctx, quote, input)
    if (projectId && !quote.projectId) {
      await ctx.tx.update(schema.quotes).set({ projectId, updatedAt: ctx.now }).where(eq(schema.quotes.id, quote.id))
    }

    const lines = await loadQuoteLines(ctx, quote.id)
    const split = quoteSplit(lines)
    let contract: 'base' | 'revision' | 'none' = 'none'
    let revisionId: string | null = null
    const scheduleIds: string[] = []
    const stageIds: string[] = []

    if (projectId) {
      const project = await loadProject(ctx, projectId, { lock: true })
      if (project.currency !== quote.currency) {
        throw new DomainError(`The project is billed in ${project.currency} and the quote in ${quote.currency}.`, 'project_currency_mismatch', 'projectId')
      }

      // 3. The one-time price: the contract, or scope added to it.
      if (split.oneTimeNetMinor !== 0) {
        const applyAs = input.applyAs ?? (project.contractValueMinor === null ? 'base' : 'addition')
        if (applyAs === 'base') {
          if (project.contractValueMinor !== null) {
            throw new DomainError('This project already has a contract value. Accept the quote as an addition to it.', 'contract_exists', 'applyAs')
          }
          ctx.require('report:readFinancial')
          await projectUpdate.handler(ctx, {
            id: project.id,
            contractValueMinor: split.oneTimeNetMinor,
            ...(project.billingModel === 'time_and_materials' || project.billingModel === 'non_billable' ? { billingModel: 'fixed_price' as const, budgetPeriod: 'total' as const } : {}),
          })
          await ctx.tx.update(schema.projects).set({ contractQuoteId: quote.id }).where(eq(schema.projects.id, project.id))
          contract = 'base'
        } else if (applyAs === 'addition') {
          revisionId = await addAsRevision(ctx, project.id, quote, split.oneTimeNetMinor, input.raiseBudget)
          contract = 'revision'
        }
      }

      // 4. What recurs: a paused schedule for each interval.
      if (split.recurring.length > 0) {
        ctx.require('billingSchedule:create')
        const startOn = input.recurringStartOn ?? project.startDate ?? undefined
        for (const part of split.recurring) {
          const created = await billingScheduleCreate.handler(ctx, {
            companyId: quote.companyId,
            projectId: project.id,
            contactId: quote.contactId,
            name: part.lines.length === 1 ? part.lines[0]!.description : `${quote.title} — ${part.unit === 'month' && part.count === 1 ? 'monthly' : `every ${part.count} ${part.unit}${part.count === 1 ? '' : 's'}`}`,
            currency: quote.currency,
            taxMode: quote.taxMode as 'exclusive' | 'inclusive',
            intervalUnit: part.unit,
            intervalCount: part.count,
            ...(startOn ? { startOn } : {}),
            lines: part.lines.map((l) => ({
              serviceId: l.serviceId,
              description: l.description,
              detail: l.detail,
              quantity: l.quantity,
              unitAmountMinor: l.unitAmountMinor,
              discountPercent: l.discountPercent,
              taxRateId: l.taxRateId,
            })),
          })
          await ctx.tx.update(schema.billingSchedules).set({ quoteId: quote.id }).where(eq(schema.billingSchedules.id, created.id))
          // Nothing bills until someone says the work is live.
          await billingScheduleChangeStatus.handler(ctx, { id: created.id, status: 'paused' })
          scheduleIds.push(created.id)
        }
      }

      // 5. How it is billed.
      if (input.stagePreset !== 'none') {
        ctx.require('projectBilling:update')
        const stages =
          input.stagePreset === 'halves'
            ? [
                { name: 'First half', basis: 'percent' as const, percent: '50' },
                { name: 'Balance', basis: 'balance' as const, invoiceStyle: 'statement' as const },
              ]
            : [
                input.depositAmountMinor != null
                  ? { name: 'Deposit', basis: 'amount' as const, amountMinor: input.depositAmountMinor }
                  : { name: 'Deposit', basis: 'percent' as const, percent: input.depositPercent ?? '50' },
                { name: 'Balance at launch', basis: 'balance' as const, invoiceStyle: 'statement' as const, trigger: 'At launch' },
              ]
        for (const stage of stages) {
          const created = await projectBillingStageCreate.handler(ctx, { id: projectId, ...stage })
          stageIds.push(created.id)
        }
      }
    } else if (input.stagePreset !== 'none' || input.applyAs === 'base' || input.applyAs === 'addition') {
      throw new DomainError('Choose the project this quote is for, or start one, to carry it into a contract or a billing plan.', 'project_required', 'projectId')
    }

    const accepted = await getQuote(ctx, quote.id)
    await ctx.emit('quote.accepted', accepted)
    return { ...accepted, applied: { projectId, contract, revisionId, scheduleIds, stageIds, declinedQuoteIds } }
  },
})

/** Declines the other open options in this quote's group, and records the choice. */
async function decideGroup(ctx: ActorContext, quote: Awaited<ReturnType<typeof loadQuote>>): Promise<string[]> {
  if (!quote.optionGroupId) return []
  const g = schema.quoteOptionGroups
  const [group] = await ctx.tx.select().from(g).where(eq(g.id, quote.optionGroupId)).limit(1).for('update')
  if (group?.decidedQuoteId) {
    throw new DomainError('The client has already chosen another option from this group.', 'option_group_decided')
  }
  const q = schema.quotes
  const siblings = await ctx.tx
    .select({ id: q.id, number: q.number, title: q.title })
    .from(q)
    .where(and(eq(q.optionGroupId, quote.optionGroupId), ne(q.id, quote.id), eq(q.status, 'sent')))
    .for('update')
  if (siblings.length > 0) {
    await ctx.tx
      .update(q)
      .set({ status: 'declined', declinedAt: ctx.now, declineReason: 'Another option was chosen.', updatedAt: ctx.now })
      .where(inArray(q.id, siblings.map((s) => s.id)))
  }
  for (const sibling of siblings) {
    await ctx.audit({
      action: 'quote.declined',
      entityType: 'quote',
      entityId: sibling.id,
      entityLabel: `${sibling.number} ${sibling.title}`,
      changes: { status: { from: 'sent', to: 'declined' }, declineReason: { from: null, to: 'Another option was chosen.' } },
    })
    await ctx.emit('quote.declined', await getQuote(ctx, sibling.id))
  }
  await ctx.tx.update(g).set({ decidedQuoteId: quote.id, decidedAt: ctx.now, updatedAt: ctx.now }).where(eq(g.id, quote.optionGroupId))
  return siblings.map((s) => s.id)
}

async function resolveProject(
  ctx: ActorContext,
  quote: Awaited<ReturnType<typeof loadQuote>>,
  input: { projectId?: string | null | undefined; createProject?: { name?: string | null | undefined; projectTypeId?: string | null | undefined; startDate?: string | null | undefined; dueDate?: string | null | undefined; ownerId?: string | null | undefined } | undefined },
): Promise<string | null> {
  if (quote.projectId) {
    if (input.projectId && input.projectId !== quote.projectId) {
      throw new DomainError('This quote is already for another project.', 'quote_project_fixed', 'projectId')
    }
    return quote.projectId
  }
  if (input.projectId) {
    const project = await loadProject(ctx, input.projectId)
    if (project.companyId !== quote.companyId) throw new DomainError('That project is for a different client.', 'project_company_mismatch', 'projectId')
    return project.id
  }
  if (input.createProject) {
    ctx.require('project:create')
    const created = await projectCreate.handler(ctx, {
      name: input.createProject.name || quote.title,
      companyId: quote.companyId,
      dealId: quote.dealId,
      currency: quote.currency,
      status: 'planning',
      startDate: input.createProject.startDate ?? null,
      dueDate: input.createProject.dueDate ?? null,
      projectTypeId: input.createProject.projectTypeId ?? null,
      ...(input.createProject.ownerId !== undefined ? { ownerId: input.createProject.ownerId } : {}),
    })
    return created.id
  }
  return null
}

/**
 * Scope added to a project's contract, on the record as any change is: a
 * revision, drafted, sent, and accepted. A revision already drafted or sent
 * against this quote is the one used, so nothing is counted twice.
 */
async function addAsRevision(ctx: ActorContext, projectId: string, quote: Awaited<ReturnType<typeof loadQuote>>, amountMinor: number, raiseBudget: boolean): Promise<string> {
  ctx.require('projectRevision:accept')
  const r = schema.projectRevisions
  const [existing] = await ctx.tx
    .select()
    .from(r)
    .where(and(eq(r.projectId, projectId), eq(r.quoteId, quote.id), inArray(r.status, ['draft', 'sent'])))
    .limit(1)
  let revisionId = existing?.id
  if (!revisionId) {
    ctx.require('projectRevision:create')
    const created = await projectRevisionCreate.handler(ctx, { id: projectId, title: quote.title, kind: 'variation', amountMinor, quoteId: quote.id })
    revisionId = created.id
  }
  if (!existing || existing.status === 'draft') await projectRevisionSend.handler(ctx, { id: revisionId })
  await projectRevisionAccept.handler(ctx, { id: revisionId, raiseBudget })
  return revisionId
}

export const quoteOptionGroupCreate = defineProcedure({
  name: 'quoteOptionGroup.create',
  summary: 'Group quotes as alternatives the client chooses between. Accepting one declines the others.',
  permission: 'quote:update',
  input: z.object({
    companyId: z.uuid(),
    projectId: z.uuid().nullish(),
    name: z.string().trim().min(1).max(200),
    /** Quotes to put in it: the client's, open, and in no other group. */
    quotes: z.array(z.object({ id: z.uuid(), label: optionalText(120) })).max(10).default([]),
  }),
  output: z.object({ id: z.uuid(), name: z.string(), quoteIds: z.array(z.uuid()) }),
  http: { method: 'POST', path: '/quote-option-groups', successStatus: 201 },
  emits: [],
  async handler(ctx, input) {
    const { loadCompany } = await import('../crm/companies.ts')
    await loadCompany(ctx, input.companyId)
    if (input.projectId) {
      const project = await loadProject(ctx, input.projectId)
      if (project.companyId !== input.companyId) throw new DomainError('That project is for a different client.', 'project_company_mismatch', 'projectId')
    }
    const id = newId()
    await ctx.tx.insert(schema.quoteOptionGroups).values({
      id,
      organizationId: ctx.organizationId,
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      name: input.name,
      createdBy: actingUserId(ctx),
    })
    for (const [i, item] of input.quotes.entries()) {
      const quote = await loadQuote(ctx, item.id, { lock: true })
      if (quote.companyId !== input.companyId) throw new DomainError('Every option must be for the same client.', 'option_group_company_mismatch', `quotes.${i}.id`)
      if (quote.optionGroupId) throw new DomainError(`${quote.number ?? quote.title} is already an option elsewhere.`, 'quote_in_group', `quotes.${i}.id`)
      if (quote.status !== 'draft' && quote.status !== 'sent') throw new DomainError(`${quote.number} is ${quote.status}.`, 'quote_answered', `quotes.${i}.id`)
      await ctx.tx
        .update(schema.quotes)
        .set({ optionGroupId: id, optionLabel: item.label ?? `Option ${String.fromCharCode(65 + i)}`, updatedAt: ctx.now })
        .where(eq(schema.quotes.id, quote.id))
    }
    await ctx.audit({ action: 'quote_option_group.created', entityType: 'quote_option_group', entityId: id, entityLabel: input.name, changes: { quotes: { from: null, to: input.quotes.length } } })
    return { id, name: input.name, quoteIds: input.quotes.map((q) => q.id) }
  },
})

// The printed quote

const QUOTE_PDF_LINK_SECONDS = 10 * 60

const quotePdfFilename = (quote: { number: string | null; title: string }) =>
  `${quote.number ?? 'draft-quote'}-${quote.title.replace(/[^\w.-]+/g, '-')}.pdf`.slice(0, 120)

export const quoteDownload = defineProcedure({
  name: 'quote.download',
  summary: 'A short-lived link to the quote as a PDF',
  permission: 'quote:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: z.object({ url: z.url(), expiresAt: z.date(), filename: z.string() }),
  http: { method: 'GET', path: '/quotes/{id}/pdf' },
  rateLimit: 'expensive',
  async handler(ctx, input) {
    const quote = await loadQuote(ctx, input.id)
    const { invoicePdfLink } = await import('./invoices.ts')
    const expiresAt = new Date(ctx.now.getTime() + QUOTE_PDF_LINK_SECONDS * 1000)
    return { url: invoicePdfLink(ctx.organizationId, quote.id, expiresAt, 'quote'), expiresAt, filename: quotePdfFilename(quote) }
  },
})

/** Renders one organization's quote for a caller already authorised by a signed link. */
export async function renderQuotePdf(organizationId: string, quoteId: string): Promise<{ filename: string; bytes: Buffer } | null> {
  const { withTenant } = await import('@workloom/db')
  const { buildContext } = await import('../../registry/index.ts')
  return withTenant(organizationId, async (tx) => {
    const ctx = buildContext({ organizationId, actor: { type: 'system', label: 'document pdf' }, role: null, permissions: new Set() }, tx)
    const [row] = await tx.select({ id: schema.quotes.id }).from(schema.quotes).where(eq(schema.quotes.id, quoteId)).limit(1)
    if (!row) return null
    const quote = await getQuote(ctx, quoteId)
    const [{ renderDocumentPdf }, { documentPdfInput }] = await Promise.all([import('@workloom/pdf'), import('./pdf.ts')])
    return { filename: quotePdfFilename(quote), bytes: await renderDocumentPdf(await documentPdfInput(ctx, quote, 'quote')) }
  })
}

export const quoteEmail = defineProcedure({
  name: 'quote.email',
  summary: 'Email a sent quote to the client, with its PDF attached',
  permission: 'quote:send',
  input: z.object({ id: z.uuid(), to: z.email().optional() }),
  output: quoteOutput,
  http: { method: 'POST', path: '/quotes/{id}/email' },
  emits: [],
  rateLimit: 'expensive',
  async handler(ctx, input) {
    const quote = await getQuote(ctx, input.id)
    if (quote.status === 'draft') throw new DomainError('Send the quote before emailing it.', 'quote_not_sent')
    await emailQuote(ctx, quote, input.to)
    return getQuote(ctx, input.id)
  },
})

/** Emails a quote after the change has committed, with its PDF built inside the transaction. */
export async function emailQuote(ctx: ActorContext, quote: Awaited<ReturnType<typeof getQuote>>, to?: string): Promise<void> {
  const address = to ?? (await contactAddress(ctx, quote.contactId)) ?? (await companyAddress(ctx, quote.companyId))
  if (!address) throw new DomainError('No email address: choose a contact for this quote, or give an address to send to.', 'no_email_address', 'to')
  const [{ quoteEmail: template }, { renderDocumentPdf }, { documentPdfInput }] = await Promise.all([
    import('@workloom/emails'),
    import('@workloom/pdf'),
    import('./pdf.ts'),
  ])
  const pdf = await renderDocumentPdf(await documentPdfInput(ctx, quote, 'quote'))
  const [org] = await ctx.tx.select({ name: schema.organization.name, legalName: schema.organization.legalName }).from(schema.organization).where(eq(schema.organization.id, ctx.organizationId)).limit(1)
  const email = {
    ...template({
      to: address,
      organization: org?.legalName || org?.name || 'Workloom',
      number: quote.number!,
      title: quote.title,
      total: quote.totalMinor,
      currency: quote.currency,
      validUntil: quote.validUntil,
    }),
    attachments: [{ filename: quotePdfFilename(quote), content: pdf, contentType: 'application/pdf' }],
  }
  await ctx.audit({ action: 'quote.emailed', entityType: 'quote', entityId: quote.id, entityLabel: `${quote.number} ${quote.title}`, changes: { emailTo: { from: null, to: address } } })
  ctx.afterCommit(async () => {
    const { sendEmail } = await import('@workloom/emails')
    await sendEmail(email)
  })
}

async function contactAddress(ctx: ActorContext, contactId: string | null): Promise<string | null> {
  if (!contactId) return null
  const [row] = await ctx.tx.select({ email: schema.contacts.email }).from(schema.contacts).where(eq(schema.contacts.id, contactId)).limit(1)
  return row?.email ?? null
}

async function companyAddress(ctx: ActorContext, companyId: string): Promise<string | null> {
  const [row] = await ctx.tx.select({ email: schema.companies.email }).from(schema.companies).where(eq(schema.companies.id, companyId)).limit(1)
  return row?.email ?? null
}
