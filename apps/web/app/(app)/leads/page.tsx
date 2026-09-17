import { leadList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ArchivedBadge, LeadStatusBadge } from '@/components/crm/badges'
import { CreateLeadForm } from '@/components/crm/lead-forms'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { LEAD_SOURCE_LABELS, label } from '@/lib/crm-labels'
import { formatDate } from '@/lib/format'
import { memberChoices, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Leads · Workloom' }

const STATUSES = ['new', 'contacted', 'qualified', 'disqualified', 'converted'] as const

export default async function LeadsPage({ searchParams }: PageProps<'/leads'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const q = param(query.q)
  const status = STATUSES.find((s) => s === param(query.status))
  const cursor = param(query.cursor)

  const [{ data: leads, nextCursor }, members, settings] = await Promise.all([
    call(leadList, { q, status, cursor, limit: 50 }),
    memberChoices(),
    organizationSettings(),
  ])

  const keep = { ...(q ? { q } : {}), ...(status ? { status } : {}) }
  const tabs = [
    { key: 'all', label: 'All', href: `/leads${q ? `?q=${encodeURIComponent(q)}` : ''}` },
    ...STATUSES.map((s) => ({
      key: s,
      label: s[0]!.toUpperCase() + s.slice(1),
      href: `/leads?${new URLSearchParams({ ...(q ? { q } : {}), status: s })}`,
    })),
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        actions={
          <SearchBox action="/leads" q={q} hidden={status ? { status } : {}} placeholder="Name, company, or email" />
        }
      />

      {viewer.permissions.has('lead:create') && (
        <Card>
          <details>
            <summary className="cursor-pointer px-5 py-4 text-sm font-semibold">Add a lead</summary>
            <div className="border-t border-line p-5">
              <CreateLeadForm members={members.choices} currentUserId={viewer.actor.type === 'user' ? viewer.actor.id : null} />
            </div>
          </details>
        </Card>
      )}

      <Card>
        <CardHeader title="Leads" action={<FilterTabs tabs={tabs} active={status ?? 'all'} />} />
        {leads.length === 0 ? (
          <EmptyState>{q || status ? 'No leads match.' : 'No leads yet. Add one above, or send them in through the API.'}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Lead</Th><Th>Source</Th><Th>Status</Th><Th>Owner</Th><Th>Added</Th></tr></thead>
            <tbody>
              {leads.map((lead) => (
                <Tr key={lead.id}>
                  <Td>
                    <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">
                      {lead.contactName ?? lead.companyName ?? lead.email}
                    </Link>
                    <div className="text-xs text-muted">
                      {[lead.contactName ? lead.companyName : null, lead.email].filter(Boolean).join(' · ')}
                    </div>
                  </Td>
                  <Td className="text-muted">{label(LEAD_SOURCE_LABELS, lead.source)}</Td>
                  <Td><span className="flex gap-1"><LeadStatusBadge status={lead.status} />{lead.archivedAt && <ArchivedBadge />}</span></Td>
                  <Td className="text-muted">{members.nameOf(lead.ownerId)}</Td>
                  <Td className="whitespace-nowrap text-muted">{formatDate(lead.createdAt, settings.timezone)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager base="/leads" params={keep} cursor={cursor} nextCursor={nextCursor} />
      </Card>
    </div>
  )
}
