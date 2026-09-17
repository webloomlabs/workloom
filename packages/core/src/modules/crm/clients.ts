import { and, count, desc, eq, ilike, inArray, isNull, lt, or, schema, sql } from '@workloom/db'
import { z } from 'zod'
import type { ActorContext } from '../../context.ts'
import type { Permission } from '../../permissions/statements.ts'
import { defineProcedure } from '../../registry/index.ts'
import { isShipped } from '../../release.ts'
import { visibleTo } from './activities.ts'
import { companyOutput, loadCompany, presentCompany } from './companies.ts'
import { contains, pageInput, paginate, searchInput } from './shared.ts'

/**
 * The client view.
 *
 * A client is a company (see packages/db/src/schema/crm.ts), and the client
 * view is everything related to one: its people, its deals, and -- as later
 * slices land -- its projects, quotes, invoices, payments, and expenses.
 *
 * The sections are declared here, all of them, with the slice that builds each
 * one. Sections from unshipped slices are reported as upcoming, so the
 * interface can show where they will go and an integration can see what is
 * coming. When a slice ships, `clients.test.ts` fails until its section counts
 * something -- which is what makes "every tab is populated as its slice lands"
 * a check rather than a hope.
 */

type SectionDefinition = {
  label: string
  /** The slice that builds it, or `phase-2` for what the MVP deliberately leaves out. */
  since: string
  /** Who may see the section at all. Absent means anyone who can read the company. */
  permission?: Permission
}

export const CLIENT_SECTIONS = {
  overview: { label: 'Overview', since: 'S4' },
  contacts: { label: 'Contacts', since: 'S3', permission: 'contact:read' },
  deals: { label: 'Deals', since: 'S3', permission: 'deal:read' },
  projects: { label: 'Projects', since: 'S5', permission: 'project:read' },
  quotes: { label: 'Quotes', since: 'S7a', permission: 'quote:read' },
  invoices: { label: 'Invoices', since: 'S7b', permission: 'invoice:read' },
  payments: { label: 'Payments', since: 'S7c', permission: 'payment:read' },
  expenses: { label: 'Expenses', since: 'S7c', permission: 'expense:read' },
  activity: { label: 'Activity', since: 'S3', permission: 'activity:read' },
  support: { label: 'Support', since: 'S11', permission: 'ticket:read' },
  maintenance: { label: 'Maintenance', since: 'S11', permission: 'maintenancePlan:read' },
  infrastructure: { label: 'Infrastructure', since: 'S11', permission: 'infrastructure:read' },
  documents: { label: 'Documents', since: 'S11', permission: 'document:read' },
} as const satisfies Record<string, SectionDefinition>

export type ClientSectionKey = keyof typeof CLIENT_SECTIONS
export const CLIENT_SECTION_KEYS = Object.keys(CLIENT_SECTIONS) as ClientSectionKey[]

type Counter = (ctx: ActorContext, companyId: string) => Promise<number>

const counted = async (query: Promise<Array<{ n: number }>>) => (await query)[0]?.n ?? 0

/**
 * How many records each section holds. One entry per shipped section that
 * lists records; the overview lists none of its own.
 */
export const SECTION_COUNTERS: Partial<Record<ClientSectionKey, Counter>> = {
  contacts: (ctx, id) =>
    counted(
      ctx.tx
        .select({ n: count() })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.companyId, id), isNull(schema.contacts.archivedAt))),
    ),
  deals: (ctx, id) =>
    counted(
      ctx.tx
        .select({ n: count() })
        .from(schema.deals)
        .where(and(eq(schema.deals.companyId, id), isNull(schema.deals.archivedAt))),
    ),
  projects: (ctx, id) =>
    counted(
      ctx.tx
        .select({ n: count() })
        .from(schema.projects)
        .where(and(eq(schema.projects.companyId, id), isNull(schema.projects.archivedAt))),
    ),
  quotes: (ctx, id) => counted(ctx.tx.select({ n: count() }).from(schema.quotes).where(eq(schema.quotes.companyId, id))),
  invoices: (ctx, id) => counted(ctx.tx.select({ n: count() }).from(schema.invoices).where(eq(schema.invoices.companyId, id))),
  payments: (ctx, id) => counted(ctx.tx.select({ n: count() }).from(schema.payments).where(eq(schema.payments.companyId, id))),
  expenses: (ctx, id) => counted(ctx.tx.select({ n: count() }).from(schema.expenses).where(eq(schema.expenses.companyId, id))),
  activity: (ctx, id) =>
    counted(
      ctx.tx
        .select({ n: count() })
        .from(schema.activities)
        .where(and(eq(schema.activities.companyId, id), visibleTo(ctx))),
    ),
  // Support counts what is still open: a client with two hundred closed
  // tickets and none outstanding is not a client with two hundred problems.
  support: (ctx, id) =>
    counted(
      ctx.tx
        .select({ n: count() })
        .from(schema.tickets)
        .where(and(eq(schema.tickets.companyId, id), sql`${schema.tickets.status} in ('open', 'in_progress', 'waiting_on_client')`)),
    ),
  maintenance: (ctx, id) =>
    counted(
      ctx.tx
        .select({ n: count() })
        .from(schema.maintenancePlans)
        .where(and(eq(schema.maintenancePlans.companyId, id), sql`${schema.maintenancePlans.status} <> 'ended'`)),
    ),
  infrastructure: (ctx, id) =>
    counted(
      ctx.tx
        .select({ n: count() })
        .from(schema.infrastructureAssets)
        .where(and(eq(schema.infrastructureAssets.companyId, id), sql`${schema.infrastructureAssets.status} <> 'decommissioned'`)),
    ),
  documents: (ctx, id) =>
    counted(ctx.tx.select({ n: count() }).from(schema.clientDocuments).where(eq(schema.clientDocuments.companyId, id))),
}

/** Sections that summarise rather than list, and so have nothing to count. */
export const UNCOUNTED_SECTIONS: readonly ClientSectionKey[] = ['overview']

const totals = z.array(z.object({ currency: z.string(), valueMinor: z.number().int() }))

const summaryOutput = z.object({
  company: companyOutput,
  sections: z.array(
    z.object({
      key: z.enum(CLIENT_SECTION_KEYS as [ClientSectionKey, ...ClientSectionKey[]]),
      label: z.string(),
      /**
       * `available` sections can be opened; `upcoming` ones arrive in a later
       * release of the MVP; `planned` ones are beyond it. Sections the caller has
       * no permission for are left out altogether.
       */
      status: z.enum(['available', 'upcoming', 'planned']),
      /** Records in the section. Null where there is nothing to count. */
      count: z.number().int().nullable(),
    }),
  ),
  /** Deal figures, per currency. Null without `deal:read`. */
  deals: z
    .object({ openCount: z.number().int(), openValue: totals, wonCount: z.number().int(), wonValue: totals })
    .nullable(),
})

async function dealFigures(ctx: ActorContext, companyId: string) {
  const d = schema.deals
  const rows = await ctx.tx
    .select({
      won: sql<boolean>`${d.stage} = 'won'`,
      currency: d.currency,
      n: sql<number>`count(*)::int`,
      total: sql<string>`sum(${d.valueMinor})::text`,
    })
    .from(d)
    .where(and(eq(d.companyId, companyId), isNull(d.archivedAt), or(isNull(d.closedAt), eq(d.stage, 'won'))))
    .groupBy(sql`1`, d.currency)
    .orderBy(d.currency)

  const pick = (won: boolean) => rows.filter((r) => r.won === won)
  return {
    openCount: pick(false).reduce((n, r) => n + r.n, 0),
    openValue: pick(false).map((r) => ({ currency: r.currency, valueMinor: Number(r.total) })),
    wonCount: pick(true).reduce((n, r) => n + r.n, 0),
    wonValue: pick(true).map((r) => ({ currency: r.currency, valueMinor: Number(r.total) })),
  }
}

export const companySummary = defineProcedure({
  name: 'company.summary',
  summary: 'The client view of a company: which sections exist, what each holds, and deal totals',
  permission: 'company:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: summaryOutput,
  http: { method: 'GET', path: '/companies/{id}/summary' },
  async handler(ctx, input) {
    const company = presentCompany(await loadCompany(ctx, input.id))

    const sections = []
    for (const key of CLIENT_SECTION_KEYS) {
      const section: SectionDefinition = CLIENT_SECTIONS[key]
      if (section.permission && !ctx.has(section.permission)) continue
      const status = section.since === 'phase-2' ? 'planned' : isShipped(section.since) ? 'available' : 'upcoming'
      const counter = status === 'available' ? SECTION_COUNTERS[key] : undefined
      sections.push({
        key,
        label: section.label,
        status: status as 'available' | 'upcoming' | 'planned',
        count: counter ? await counter(ctx, company.id) : null,
      })
    }

    return {
      company,
      sections,
      deals: ctx.has('deal:read') ? await dealFigures(ctx, company.id) : null,
    }
  },
})

const CLIENT_STAGES = ['client', 'former_client'] as const

export const clientList = defineProcedure({
  name: 'client.list',
  summary: 'Clients, with their open deals and contact counts, newest first',
  permission: 'company:read',
  readOnly: true,
  input: z.object({
    q: searchInput,
    /** Current clients, former clients, or (omitted) both. */
    lifecycleStage: z.enum(CLIENT_STAGES).optional(),
    ...pageInput,
  }),
  output: z.object({
    data: z.array(
      companyOutput.extend({
        contactCount: z.number().int().nullable(),
        /** Open deals per currency. Null without `deal:read`. */
        openDeals: z.object({ count: z.number().int(), value: totals }).nullable(),
      }),
    ),
    nextCursor: z.uuid().nullable(),
  }),
  http: { method: 'GET', path: '/clients' },
  async handler(ctx, input) {
    const c = schema.companies
    const rows = await ctx.tx
      .select()
      .from(c)
      .where(
        and(
          isNull(c.archivedAt),
          input.lifecycleStage ? eq(c.lifecycleStage, input.lifecycleStage) : inArray(c.lifecycleStage, [...CLIENT_STAGES]),
          input.q ? or(ilike(c.name, contains(input.q)), ilike(c.website, contains(input.q))) : undefined,
          input.cursor ? lt(c.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(c.id))
      .limit(input.limit + 1)

    const page = paginate(rows.map(presentCompany), input.limit)
    const ids = page.data.map((row) => row.id)

    // Two grouped queries for the whole page, rather than two per client.
    const contactCounts =
      ids.length > 0 && ctx.has('contact:read')
        ? await ctx.tx
            .select({ companyId: schema.contacts.companyId, n: sql<number>`count(*)::int` })
            .from(schema.contacts)
            .where(and(inArray(schema.contacts.companyId, ids), isNull(schema.contacts.archivedAt)))
            .groupBy(schema.contacts.companyId)
        : []
    const openDeals =
      ids.length > 0 && ctx.has('deal:read')
        ? await ctx.tx
            .select({
              companyId: schema.deals.companyId,
              currency: schema.deals.currency,
              n: sql<number>`count(*)::int`,
              total: sql<string>`sum(${schema.deals.valueMinor})::text`,
            })
            .from(schema.deals)
            .where(and(inArray(schema.deals.companyId, ids), isNull(schema.deals.archivedAt), isNull(schema.deals.closedAt)))
            .groupBy(schema.deals.companyId, schema.deals.currency)
            .orderBy(schema.deals.currency)
        : []

    return {
      nextCursor: page.nextCursor,
      data: page.data.map((company) => {
        const deals = openDeals.filter((d) => d.companyId === company.id)
        return {
          ...company,
          contactCount: ctx.has('contact:read')
            ? (contactCounts.find((r) => r.companyId === company.id)?.n ?? 0)
            : null,
          openDeals: ctx.has('deal:read')
            ? {
                count: deals.reduce((n, d) => n + d.n, 0),
                value: deals.map((d) => ({ currency: d.currency, valueMinor: Number(d.total) })),
              }
            : null,
        }
      }),
    }
  },
})
