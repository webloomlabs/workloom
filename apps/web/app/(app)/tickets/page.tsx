import { ticketList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr, buttonStyles } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { SlaBadge, TicketPriorityBadge, TicketStatusBadge } from '@/components/service/badges'
import { formatDate } from '@/lib/format'
import { memberChoices } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Tickets · Workloom' }

/**
 * The support queue.
 *
 * "Open" is the view people live in, so it is the default; "Late" is the one
 * that decides what to do next, and it is answered by the database rather than
 * by filtering a page of results in the browser.
 */
const VIEWS = {
  open: { label: 'Open', filter: { open: true } },
  breached: { label: 'Late', filter: { breached: true } },
  unassigned: { label: 'Unassigned', filter: { open: true, unassigned: true } },
  resolved: { label: 'Resolved', filter: { status: 'resolved' as const } },
  all: { label: 'All', filter: {} },
}

export default async function TicketsPage({ searchParams }: PageProps<'/tickets'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const view = (param(query.view) ?? 'open') as keyof typeof VIEWS
  const { filter } = VIEWS[view] ?? VIEWS.open
  const q = param(query.q)
  const cursor = param(query.cursor)

  const [tickets, members] = await Promise.all([
    call(ticketList, { ...filter, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}), limit: 50 }),
    memberChoices(),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tickets"
        description="What clients have asked for since the work shipped, and what was promised on each."
        actions={
          viewer.permissions.has('ticket:create') && (
            <Link href="/tickets/new" className={buttonStyles()}>
              Raise a ticket
            </Link>
          )
        }
      />
      <Card>
        <CardHeader
          title={VIEWS[view]?.label ?? 'Open'}
          action={
            <div className="flex flex-wrap items-center gap-3">
              <FilterTabs
                active={view}
                tabs={Object.entries(VIEWS).map(([key, v]) => ({ key, label: v.label, href: key === 'open' ? '/tickets' : `/tickets?view=${key}` }))}
              />
              <SearchBox action="/tickets" q={q} hidden={view === 'open' ? {} : { view }} placeholder="Number, title, or text" />
            </div>
          }
        />
        {tickets.data.length === 0 ? (
          <EmptyState>
            {q || view !== 'open' ? 'Nothing matches.' : 'Nothing outstanding. The queue is empty.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Ticket</Th>
                <Th>Client</Th>
                <Th>Status</Th>
                <Th>Targets</Th>
                <Th>Assigned</Th>
                <Th>Raised</Th>
              </tr>
            </thead>
            <tbody>
              {tickets.data.map((ticket) => (
                <Tr key={ticket.id}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <Link href={`/tickets/${ticket.id}`} className="font-medium hover:underline">
                        {ticket.title}
                      </Link>
                      <TicketPriorityBadge priority={ticket.priority} />
                    </div>
                    <div className="text-xs text-muted">
                      {ticket.number}
                      {ticket.projectName ? ` · ${ticket.projectName}` : ''}
                    </div>
                  </Td>
                  <Td className="text-muted">
                    {ticket.companyId ? (
                      <Link href={`/companies/${ticket.companyId}?tab=support`} className="hover:underline">
                        {ticket.companyName}
                      </Link>
                    ) : (
                      'Internal'
                    )}
                  </Td>
                  <Td><TicketStatusBadge status={ticket.status} /></Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <SlaBadge state={ticket.responseState} what="Response" />
                      <SlaBadge state={ticket.resolutionState} what="Resolution" />
                    </div>
                  </Td>
                  <Td className="text-muted">{ticket.assigneeName ?? members.nameOf(null)}</Td>
                  <Td className="whitespace-nowrap text-muted">{formatDate(ticket.createdAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager
          base="/tickets"
          params={{ ...(view === 'open' ? {} : { view }), ...(q ? { q } : {}) }}
          cursor={cursor}
          nextCursor={tickets.nextCursor}
        />
      </Card>
    </div>
  )
}
