import { companyList, projectList, ticketGet, ticketMessageList } from '@workloom/core/modules'
import { Alert, Card, CardBody, CardHeader, EmptyState, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { SlaBadge, TicketPriorityBadge, TicketStatusBadge } from '@/components/service/badges'
import { DeleteTicketButton, EditTicketForm, ReplyForm, TicketStatusControl } from '@/components/service/ticket-forms'
import { label } from '@/lib/crm-labels'
import { formatDateTime } from '@/lib/format'
import { TICKET_TYPE_LABELS } from '@/lib/service-labels'
import { memberChoices, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Ticket · Workloom' }

export default async function TicketPage({ params }: PageProps<'/tickets/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (permission: Parameters<typeof viewer.permissions.has>[0]) => viewer.permissions.has(permission)

  const ticket = await call(ticketGet, { id }).catch(() => null)
  if (!ticket) notFound()

  const [messages, settings, members, companies, projects] = await Promise.all([
    call(ticketMessageList, { ticketId: id, limit: 100 }),
    organizationSettings(),
    memberChoices(),
    can('company:read') ? call(companyList, { limit: 100 }) : Promise.resolve({ data: [] }),
    can('project:read') ? call(projectList, { limit: 100 }) : Promise.resolve({ data: [] }),
  ])

  const target = (due: Date | null, happened: Date | null, state: string) =>
    due === null ? 'Nothing promised' : `${formatDateTime(due, settings.timezone)}${happened ? ` · ${state}` : ''}`

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/tickets" className="text-sm text-muted hover:text-ink">← Tickets</Link>}
        title={ticket.title}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <TicketStatusBadge status={ticket.status} />
            <TicketPriorityBadge priority={ticket.priority} />
            <SlaBadge state={ticket.responseState} what="Response" />
            <SlaBadge state={ticket.resolutionState} what="Resolution" />
            <span className="font-medium text-ink">{ticket.number}</span>
            <span>· {label(TICKET_TYPE_LABELS, ticket.type)}</span>
            {ticket.companyId && (
              <Link href={`/companies/${ticket.companyId}?tab=support`} className="hover:text-ink">
                · {ticket.companyName}
              </Link>
            )}
            {ticket.projectId && (
              <Link href={`/projects/${ticket.projectId}`} className="hover:text-ink">
                · {ticket.projectName}
              </Link>
            )}
            <span>· {ticket.assigneeName ?? 'Unassigned'}</span>
          </div>
        }
        actions={
          <>
            {can('ticket:update') && <TicketStatusControl id={ticket.id} status={ticket.status} />}
            {can('ticket:delete') && <DeleteTicketButton id={ticket.id} />}
          </>
        }
      />

      {ticket.responseState === 'breached' && !ticket.firstRespondedAt && (
        <Alert tone="error">
          Nobody has replied to this client, and the response target passed {formatDateTime(ticket.firstResponseDueAt, settings.timezone)}.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card>
            <CardHeader title="What happened" />
            <CardBody className="whitespace-pre-wrap text-sm text-ink">{ticket.body}</CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Conversation"
              description="Replies go to the client; notes stay inside the agency."
            />
            {messages.data.length === 0 ? (
              <EmptyState>Nothing said yet.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {messages.data.map((message) => (
                  <li key={message.id} className={message.internal ? 'bg-raised/50 px-5 py-3' : 'px-5 py-3'}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-muted">
                      <span className="font-medium text-ink">
                        {message.authorName ?? 'Former member'}
                        {message.internal && <span className="ml-2 rounded bg-raised px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint">Internal</span>}
                      </span>
                      <span>{formatDateTime(message.createdAt, settings.timezone)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{message.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {can('ticket:update') && (
              <CardBody className="border-t border-line">
                <ReplyForm ticketId={ticket.id} status={ticket.status} canResolve />
              </CardBody>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Service level" description="What was promised when this ticket arrived." />
            <CardBody className="space-y-3 text-sm">
              <div>
                <div className="text-xs font-medium uppercase tracking-[0.06em] text-faint">First response</div>
                <div className="text-ink">{target(ticket.firstResponseDueAt, ticket.firstRespondedAt, ticket.responseState)}</div>
                <div className="text-xs text-muted">
                  {ticket.firstRespondedAt ? `Answered ${formatDateTime(ticket.firstRespondedAt, settings.timezone)}` : 'Not answered yet'}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase tracking-[0.06em] text-faint">Resolution</div>
                <div className="text-ink">{target(ticket.resolutionDueAt, ticket.resolvedAt, ticket.resolutionState)}</div>
                <div className="text-xs text-muted">
                  {ticket.resolvedAt ? `Resolved ${formatDateTime(ticket.resolvedAt, settings.timezone)}` : 'Not resolved yet'}
                </div>
              </div>
            </CardBody>
          </Card>

          {can('ticket:update') && (
            <Card>
              <details>
                <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-ink">Edit details</summary>
                <CardBody className="border-t border-line">
                  <EditTicketForm
                    ticket={ticket}
                    companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
                    projects={projects.data.map((p) => ({ id: p.id, name: p.name }))}
                    members={members.choices}
                  />
                </CardBody>
              </details>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
