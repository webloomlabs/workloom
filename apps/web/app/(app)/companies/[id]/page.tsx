import type { Permission } from '@workloom/core'
import {
  activityList,
  companySummary,
  contactList,
  dealList,
  expenseList,
  invoiceList,
  paymentList,
  projectList,
  quoteList,
  type ClientSectionKey,
} from '@workloom/core/modules'
import { Alert, Badge, Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { LogActivityForm, Timeline } from '@/components/crm/activity'
import { ArchivedBadge, DealStageBadge, LifecycleBadge } from '@/components/crm/badges'
import { Pager, param } from '@/components/crm/list-controls'
import { ArchiveControl, CreateContactForm, EditCompanyForm } from '@/components/crm/record-forms'
import { SectionTabs, type SectionTab } from '@/components/crm/section-tabs'
import { InvoiceStatusBadge, QuoteStatusBadge } from '@/components/finance/badges'
import { ProgressBar, ProjectStatusBadge } from '@/components/projects/badges'
import { PAYMENT_METHOD_LABELS } from '@/lib/finance-labels'
import { formatDate } from '@/lib/format'
import { memberChoices, money, organizationSettings, timeline } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Client · Workloom' }

type Summary = Awaited<ReturnType<typeof loadSummary>>
const loadSummary = (id: string) => call(companySummary, { id })

type Context = {
  id: string
  summary: Summary
  can: (permission: Permission) => boolean
  cursor: string | undefined
  timezone: string
  baseCurrency: string
  currentUserId: string | null
  members: Awaited<ReturnType<typeof memberChoices>>
}

/**
 * The client view: one company and everything related to it.
 *
 * Which sections exist, and which are still to come, is decided in
 * packages/core (`CLIENT_SECTIONS`) and arrives with the summary. This page
 * supplies the content for each available section. When a slice ships and its
 * section becomes available, add its entry here.
 */
const SECTION_CONTENT: Record<ClientSectionKey, ((ctx: Context) => Promise<ReactNode>) | null> = {
  overview: Overview,
  contacts: Contacts,
  deals: Deals,
  activity: Activity,
  projects: Projects,
  quotes: Quotes,
  invoices: Invoices,
  payments: Payments,
  expenses: Expenses,
  support: null,
  maintenance: null,
  infrastructure: null,
  documents: null,
}

/** Not a section of the client record, just the place to edit the company itself. */
const DETAILS = 'details'

export default async function CompanyPage({ params, searchParams }: PageProps<'/companies/[id]'>) {
  const { id } = await params
  const query = await searchParams
  const viewer = await requireViewer()
  const can = (p: Permission) => viewer.permissions.has(p)

  const [summary, members, settings] = await Promise.all([loadSummary(id), memberChoices(), organizationSettings()])
  const { company } = summary
  const base = `/companies/${id}`

  const tabs: SectionTab[] = summary.sections.map((s) => ({
    key: s.key,
    label: s.label,
    status: s.status,
    count: s.count,
    href: s.key === 'overview' ? base : `${base}?tab=${s.key}`,
  }))
  // Last among the tabs that open; the section tabs render available ones first.
  tabs.push({ key: DETAILS, label: 'Details', status: 'available', href: `${base}?tab=${DETAILS}` })

  const requested = param(query.tab)
  const active = tabs.find((t) => t.key === requested && t.status === 'available')?.key ?? 'overview'
  const context: Context = {
    id,
    summary,
    can,
    cursor: param(query.cursor),
    timezone: settings.timezone,
    baseCurrency: settings.baseCurrency,
    currentUserId: viewer.actor.type === 'user' ? viewer.actor.id : null,
    members,
  }

  let content: ReactNode
  if (active === DETAILS) {
    content = <Details context={context} />
  } else {
    const render = SECTION_CONTENT[active as ClientSectionKey]
    content = render ? await render(context) : (
      <Alert tone="info">This section is available through the API, but has no page yet.</Alert>
    )
  }

  const isClient = company.lifecycleStage !== 'prospect'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href={isClient ? '/clients' : '/companies'} className="text-sm text-neutral-500 hover:underline">
            ← {isClient ? 'Clients' : 'Companies'}
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{company.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
            <LifecycleBadge stage={company.lifecycleStage} />
            {company.archivedAt && <ArchivedBadge />}
            {company.becameClientAt && <span>Client since {formatDate(company.becameClientAt, settings.timezone)}</span>}
            <span>· {members.nameOf(company.ownerId)}</span>
            {company.website && (
              <a href={company.website} target="_blank" rel="noreferrer noopener" className="hover:underline">
                · {company.website.replace(/^https?:\/\//, '')}
              </a>
            )}
          </p>
        </div>
        {can('company:archive') && (
          <ArchiveControl entity="company" id={company.id} archived={Boolean(company.archivedAt)} label="company" />
        )}
      </div>

      <SectionTabs tabs={tabs} active={active} label="Client sections" />

      {content}
    </div>
  )
}

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {detail && <div className="text-xs text-neutral-500">{detail}</div>}
    </Card>
  )
}

/** Per-currency totals joined, or zero in the organization's own currency. */
const totalsText = (totals: Array<{ currency: string; valueMinor: number }>, baseCurrency: string) =>
  totals.length === 0 ? money(0, baseCurrency) : totals.map((t) => money(t.valueMinor, t.currency)).join(' + ')

async function Overview({ id, summary, can, timezone, baseCurrency, members }: Context) {
  const { company, deals: figures } = summary
  const count = (key: ClientSectionKey) => summary.sections.find((s) => s.key === key)?.count
  const base = `/companies/${id}`

  const [contacts, openDeals, activities] = await Promise.all([
    can('contact:read') ? call(contactList, { companyId: id, limit: 5 }) : null,
    can('deal:read') ? call(dealList, { companyId: id, open: true, limit: 5 }) : null,
    can('activity:read') ? call(activityList, { companyId: id, limit: 5 }) : null,
  ])

  const facts = (
    [
      ['Owner', members.nameOf(company.ownerId)],
      ['Industry', company.industry],
      ['Email', company.email && <a href={`mailto:${company.email}`} className="hover:underline">{company.email}</a>],
      ['Phone', company.phone],
      ['Address', company.address],
      ['Last activity', company.lastActivityAt ? formatDate(company.lastActivityAt, timezone) : null],
    ] as const
  ).filter(([, v]) => v)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {contacts && <Stat label="Contacts" value={count('contacts') ?? 0} />}
        {figures && (
          <>
            <Stat label="Open deals" value={totalsText(figures.openValue, baseCurrency)} detail={`${figures.openCount} open`} />
            <Stat label="Won" value={totalsText(figures.wonValue, baseCurrency)} detail={`${figures.wonCount} won`} />
          </>
        )}
        {activities && (
          <Stat label="Activity" value={count('activity') ?? 0} detail={company.lastActivityAt ? `Last ${formatDate(company.lastActivityAt, timezone)}` : 'Nothing logged yet'} />
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <CardHeader title="About" action={can('company:update') ? <Link href={`${base}?tab=details`} className="text-sm hover:underline">Edit</Link> : null} />
            <div className="space-y-4 p-5 text-sm">
              {company.description && <p className="whitespace-pre-wrap">{company.description}</p>}
              {facts.length > 0 ? (
                <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
                  {facts.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-neutral-500">{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                !company.description && <p className="text-neutral-500">No details yet.</p>
              )}
            </div>
          </Card>

          {contacts && (
            <Card>
              <CardHeader title="People" action={<Link href={`${base}?tab=contacts`} className="text-sm hover:underline">All contacts</Link>} />
              {contacts.data.length === 0 ? (
                <EmptyState>No contacts yet.</EmptyState>
              ) : (
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {contacts.data.map((c) => (
                    <li key={c.id} className="flex items-baseline justify-between gap-3 px-5 py-2.5 text-sm">
                      <span>
                        <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName}</Link>
                        {c.jobTitle && <span className="text-neutral-500"> · {c.jobTitle}</span>}
                      </span>
                      <span className="truncate text-neutral-500">{c.email ?? c.phone ?? ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-6">
          {openDeals && (
            <Card>
              <CardHeader title="Open deals" action={<Link href={`${base}?tab=deals`} className="text-sm hover:underline">All deals</Link>} />
              {openDeals.data.length === 0 ? (
                <EmptyState>No open deals.</EmptyState>
              ) : (
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {openDeals.data.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                      <span className="flex items-center gap-2">
                        <Link href={`/deals/${d.id}`} className="font-medium hover:underline">{d.name}</Link>
                        <DealStageBadge stage={d.stage} />
                      </span>
                      <span className="tabular-nums">{money(d.valueMinor, d.currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {activities && (
            <Card>
              <CardHeader title="Recent activity" action={<Link href={`${base}?tab=activity`} className="text-sm hover:underline">All activity</Link>} />
              <Timeline entries={timeline(activities.data, timezone, { showLead: true })} canDelete={false} returnTo={base} />
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

async function Contacts({ id, summary, can, cursor, currentUserId, members }: Context) {
  const contacts = await call(contactList, { companyId: id, limit: 50, ...(cursor ? { cursor } : {}) })
  const live = !summary.company.archivedAt
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Contacts" />
        {contacts.data.length === 0 ? (
          <EmptyState>No contacts yet.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Email</Th><Th>Phone</Th><Th>Owner</Th></tr></thead>
            <tbody>
              {contacts.data.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName}</Link>
                    {c.jobTitle && <div className="text-xs text-neutral-500">{c.jobTitle}</div>}
                  </Td>
                  <Td className="text-neutral-600">{c.email ?? '—'}</Td>
                  <Td className="whitespace-nowrap text-neutral-600">{c.phone ?? '—'}</Td>
                  <Td className="text-neutral-600">{members.nameOf(c.ownerId)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager base={`/companies/${id}`} params={{ tab: 'contacts' }} cursor={cursor} nextCursor={contacts.nextCursor} />
      </Card>
      {live && can('contact:create') && (
        <Card>
          <CardHeader title="Add a contact" />
          <div className="p-5">
            <CreateContactForm members={members.choices} currentUserId={currentUserId} companyId={id} returnTo={`/companies/${id}?tab=contacts`} />
          </div>
        </Card>
      )}
    </div>
  )
}

async function Deals({ id, summary, can, cursor, timezone, baseCurrency, members }: Context) {
  const deals = await call(dealList, { companyId: id, limit: 50, ...(cursor ? { cursor } : {}) })
  const figures = summary.deals
  const live = !summary.company.archivedAt
  return (
    <Card>
      <CardHeader
        title="Deals"
        description={figures ? `${totalsText(figures.openValue, baseCurrency)} open · ${totalsText(figures.wonValue, baseCurrency)} won` : undefined}
        action={live && can('deal:create') ? <Link href={`/deals/new?companyId=${id}`} className="text-sm font-medium hover:underline">New deal</Link> : null}
      />
      {deals.data.length === 0 ? (
        <EmptyState>No deals yet.</EmptyState>
      ) : (
        <Table>
          <thead><tr><Th>Deal</Th><Th>Stage</Th><Th className="text-right">Value</Th><Th>Owner</Th><Th>Close</Th></tr></thead>
          <tbody>
            {deals.data.map((d) => (
              <tr key={d.id}>
                <Td>
                  <Link href={`/deals/${d.id}`} className="font-medium hover:underline">{d.name}</Link>
                  {d.contactName && <div className="text-xs text-neutral-500">{d.contactName}</div>}
                </Td>
                <Td><span className="flex gap-1"><DealStageBadge stage={d.stage} />{d.archivedAt && <ArchivedBadge />}</span></Td>
                <Td className="whitespace-nowrap text-right tabular-nums">{money(d.valueMinor, d.currency)}</Td>
                <Td className="text-neutral-600">{members.nameOf(d.ownerId)}</Td>
                <Td className="whitespace-nowrap text-neutral-500">{d.closedAt ? formatDate(d.closedAt, timezone) : formatDate(d.expectedCloseDate)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pager base={`/companies/${id}`} params={{ tab: 'deals' }} cursor={cursor} nextCursor={deals.nextCursor} />
    </Card>
  )
}

async function Projects({ id, summary, can, cursor, members }: Context) {
  const projects = await call(projectList, { companyId: id, limit: 50, includeArchived: false, ...(cursor ? { cursor } : {}) })
  const live = !summary.company.archivedAt
  return (
    <Card>
      <CardHeader
        title="Projects"
        action={live && can('project:create') ? <Link href={`/projects/new?companyId=${id}`} className="text-sm font-medium hover:underline">New project</Link> : null}
      />
      {projects.data.length === 0 ? (
        <EmptyState>No projects yet.</EmptyState>
      ) : (
        <Table>
          <thead><tr><Th>Project</Th><Th>Status</Th><Th>Progress</Th><Th>Owner</Th><Th>Due</Th></tr></thead>
          <tbody>
            {projects.data.map((p) => (
              <tr key={p.id}>
                <Td><Link href={`/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link></Td>
                <Td><ProjectStatusBadge status={p.status} /></Td>
                <Td><ProgressBar percent={p.progress.percent} detail={`${p.progress.tasksDone} of ${p.progress.tasksTotal} tasks done`} /></Td>
                <Td className="text-neutral-600">{members.nameOf(p.ownerId)}</Td>
                <Td className="whitespace-nowrap text-neutral-500">{formatDate(p.dueDate)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pager base={`/companies/${id}`} params={{ tab: 'projects' }} cursor={cursor} nextCursor={projects.nextCursor} />
    </Card>
  )
}

async function Quotes({ id, summary, can, cursor }: Context) {
  const quotes = await call(quoteList, { companyId: id, limit: 50, ...(cursor ? { cursor } : {}) })
  const live = !summary.company.archivedAt
  return (
    <Card>
      <CardHeader
        title="Quotes"
        action={live && can('quote:create') ? <Link href={`/quotes/new?companyId=${id}`} className="text-sm font-medium hover:underline">New quote</Link> : null}
      />
      {quotes.data.length === 0 ? (
        <EmptyState>No quotes yet.</EmptyState>
      ) : (
        <Table>
          <thead><tr><Th>Quote</Th><Th>Status</Th><Th className="text-right">Total</Th><Th>Valid until</Th></tr></thead>
          <tbody>
            {quotes.data.map((q) => (
              <tr key={q.id}>
                <Td>
                  <Link href={`/quotes/${q.id}`} className="font-medium hover:underline">{q.title}</Link>
                  <div className="text-xs text-neutral-500">{q.number ?? 'Draft'}</div>
                </Td>
                <Td><QuoteStatusBadge status={q.status} /></Td>
                <Td className="whitespace-nowrap text-right tabular-nums">{money(q.totalMinor, q.currency)}</Td>
                <Td className="whitespace-nowrap text-neutral-500">{formatDate(q.validUntil)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pager base={`/companies/${id}`} params={{ tab: 'quotes' }} cursor={cursor} nextCursor={quotes.nextCursor} />
    </Card>
  )
}

async function Invoices({ id, summary, can, cursor }: Context) {
  const invoices = await call(invoiceList, { companyId: id, limit: 50, ...(cursor ? { cursor } : {}) })
  const live = !summary.company.archivedAt
  return (
    <Card>
      <CardHeader
        title="Invoices"
        action={live && can('invoice:create') ? <Link href={`/invoices/new?companyId=${id}`} className="text-sm font-medium hover:underline">New invoice</Link> : null}
      />
      {invoices.data.length === 0 ? (
        <EmptyState>No invoices yet.</EmptyState>
      ) : (
        <Table>
          <thead><tr><Th>Invoice</Th><Th>Status</Th><Th className="text-right">Total</Th><Th className="text-right">Due</Th><Th>Due date</Th></tr></thead>
          <tbody>
            {invoices.data.map((invoice) => (
              <tr key={invoice.id}>
                <Td>
                  <Link href={`/invoices/${invoice.id}`} className="font-medium hover:underline">{invoice.title}</Link>
                  <div className="text-xs text-neutral-500">{invoice.number ?? 'Draft'}</div>
                </Td>
                <Td><InvoiceStatusBadge status={invoice.status} /></Td>
                <Td className="whitespace-nowrap text-right tabular-nums">{money(invoice.totalMinor, invoice.currency)}</Td>
                <Td className="whitespace-nowrap text-right tabular-nums">{invoice.amountDueMinor === 0 ? '—' : money(invoice.amountDueMinor, invoice.currency)}</Td>
                <Td className="whitespace-nowrap text-neutral-500">{formatDate(invoice.dueDate)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pager base={`/companies/${id}`} params={{ tab: 'invoices' }} cursor={cursor} nextCursor={invoices.nextCursor} />
    </Card>
  )
}

async function Payments({ id, summary, can, cursor }: Context) {
  const payments = await call(paymentList, { companyId: id, limit: 50, ...(cursor ? { cursor } : {}) })
  const live = !summary.company.archivedAt
  return (
    <Card>
      <CardHeader
        title="Payments"
        description="Money received from this client, and money refunded to them."
        action={live && can('payment:create') ? <Link href={`/payments/new?companyId=${id}`} className="text-sm font-medium hover:underline">Record a payment</Link> : null}
      />
      {payments.data.length === 0 ? (
        <EmptyState>Nothing received yet.</EmptyState>
      ) : (
        <Table>
          <thead><tr><Th>Date</Th><Th>How</Th><Th>Reference</Th><Th>Against</Th><Th className="text-right">Amount</Th></tr></thead>
          <tbody>
            {payments.data.map((payment) => (
              <tr key={payment.id}>
                <Td className="whitespace-nowrap">
                  <Link href={`/payments/${payment.id}`} className="font-medium hover:underline">{formatDate(payment.receivedOn)}</Link>
                  {payment.kind === 'refund' && <div className="text-xs text-amber-600">Refund</div>}
                </Td>
                <Td className="text-neutral-600">{PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}</Td>
                <Td className="text-neutral-600">{payment.reference ?? '—'}</Td>
                <Td className="text-neutral-600">
                  {payment.allocations.length === 0
                    ? <span className="text-neutral-400">On account</span>
                    : payment.allocations.map((a) => (
                        <Link key={a.id} href={`/invoices/${a.invoiceId}`} className="mr-2 hover:underline">{a.invoiceNumber ?? a.invoiceTitle}</Link>
                      ))}
                </Td>
                <Td className="whitespace-nowrap text-right tabular-nums">{money(payment.amountMinor, payment.currency)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pager base={`/companies/${id}`} params={{ tab: 'payments' }} cursor={cursor} nextCursor={payments.nextCursor} />
    </Card>
  )
}

async function Expenses({ id, summary, can, cursor }: Context) {
  const expenses = await call(expenseList, { companyId: id, limit: 50, ...(cursor ? { cursor } : {}) })
  const live = !summary.company.archivedAt
  return (
    <Card>
      <CardHeader
        title="Expenses"
        description="What this client's work cost, net of tax. Billable ones are rebilled onto an invoice."
        action={live && can('expense:create') ? <Link href={`/expenses/new?companyId=${id}`} className="text-sm font-medium hover:underline">Record an expense</Link> : null}
      />
      {expenses.data.length === 0 ? (
        <EmptyState>No expenses yet.</EmptyState>
      ) : (
        <Table>
          <thead><tr><Th>Date</Th><Th>What</Th><Th>Project</Th><Th className="text-right">Cost</Th><Th>Rebilling</Th></tr></thead>
          <tbody>
            {expenses.data.map((expense) => (
              <tr key={expense.id}>
                <Td className="whitespace-nowrap text-neutral-500">{formatDate(expense.incurredOn)}</Td>
                <Td><Link href={`/expenses/${expense.id}`} className="font-medium hover:underline">{expense.description}</Link></Td>
                <Td className="text-neutral-600">
                  {expense.projectId ? <Link href={`/projects/${expense.projectId}`} className="hover:underline">{expense.projectName}</Link> : '—'}
                </Td>
                <Td className="whitespace-nowrap text-right tabular-nums">{money(expense.amountMinor, expense.currency)}</Td>
                <Td className="whitespace-nowrap">
                  {expense.invoiceId ? (
                    <Link href={`/invoices/${expense.invoiceId}`}><Badge tone="green">{expense.invoiceNumber ?? 'Rebilled'}</Badge></Link>
                  ) : expense.billable ? (
                    <Badge tone="amber">To rebill</Badge>
                  ) : (
                    <span className="text-sm text-neutral-400">Absorbed</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pager base={`/companies/${id}`} params={{ tab: 'expenses' }} cursor={cursor} nextCursor={expenses.nextCursor} />
    </Card>
  )
}

async function Activity({ id, summary, can, cursor, timezone }: Context) {
  const [activities, deals, contacts] = await Promise.all([
    call(activityList, { companyId: id, limit: 50, ...(cursor ? { cursor } : {}) }),
    can('deal:read') ? call(dealList, { companyId: id, limit: 100, includeArchived: true }) : null,
    can('contact:read') ? call(contactList, { companyId: id, limit: 100, includeArchived: true }) : null,
  ])
  const base = `/companies/${id}`
  return (
    <Card>
      <CardHeader title="Activity" description="Everything logged against this company, its contacts, and its deals." />
      {!summary.company.archivedAt && can('activity:create') && (
        <div className="border-b border-neutral-200 p-5 dark:border-neutral-800">
          <LogActivityForm target="companyId" targetId={id} returnTo={base} />
        </div>
      )}
      <Timeline
        entries={timeline(activities.data, timezone, {
          deals: new Map((deals?.data ?? []).map((d) => [d.id, d.name])),
          contacts: new Map((contacts?.data ?? []).map((c) => [c.id, c.fullName])),
          showLead: true,
        })}
        canDelete={can('activity:delete')}
        returnTo={base}
      />
      <Pager base={base} params={{ tab: 'activity' }} cursor={cursor} nextCursor={activities.nextCursor} />
    </Card>
  )
}

function Details({ context: { summary, can, members } }: { context: Context }) {
  const { company } = summary
  return (
    <Card>
      <CardHeader title="Details" />
      <div className="p-5">
        {can('company:update') ? (
          <EditCompanyForm company={company} members={members.choices} />
        ) : (
          <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
            {(
              [
                ['Website', company.website],
                ['Industry', company.industry],
                ['Email', company.email],
                ['Phone', company.phone],
                ['Address', company.address],
                ['About', company.description],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-neutral-500">{k}</dt>
                <dd className="whitespace-pre-wrap">{v ?? '—'}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Card>
  )
}
