import { companyList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ArchivedBadge, LifecycleBadge } from '@/components/crm/badges'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { CreateCompanyForm } from '@/components/crm/record-forms'
import { formatDate } from '@/lib/format'
import { memberChoices, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Companies · Workloom' }

const STAGES = { prospect: 'Prospects', client: 'Clients', former_client: 'Former clients' } as const

export default async function CompaniesPage({ searchParams }: PageProps<'/companies'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const q = param(query.q)
  const stage = (Object.keys(STAGES) as Array<keyof typeof STAGES>).find((s) => s === param(query.stage))
  const includeArchived = param(query.archived) === 'true'
  const cursor = param(query.cursor)

  const [{ data: companies, nextCursor }, members, settings] = await Promise.all([
    call(companyList, { q, lifecycleStage: stage, includeArchived, cursor, limit: 50 }),
    memberChoices(),
    organizationSettings(),
  ])

  const base = { ...(q ? { q } : {}) }
  const tabs = [
    { key: 'all', label: 'All', href: `/companies?${new URLSearchParams(base)}` },
    ...Object.entries(STAGES).map(([key, text]) => ({ key, label: text, href: `/companies?${new URLSearchParams({ ...base, stage: key })}` })),
    { key: 'archived', label: 'Include archived', href: `/companies?${new URLSearchParams({ ...base, archived: 'true' })}` },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Companies</h1>
        <SearchBox action="/companies" q={q} hidden={stage ? { stage } : {}} placeholder="Name or website" />
      </div>

      {viewer.permissions.has('company:create') && (
        <Card>
          <details>
            <summary className="cursor-pointer px-5 py-4 text-sm font-semibold">Add a company</summary>
            <div className="border-t border-neutral-200 p-5 dark:border-neutral-800">
              <CreateCompanyForm members={members.choices} currentUserId={viewer.actor.type === 'user' ? viewer.actor.id : null} />
            </div>
          </details>
        </Card>
      )}

      <Card>
        <CardHeader title="Companies" action={<FilterTabs tabs={tabs} active={includeArchived ? 'archived' : (stage ?? 'all')} />} />
        {companies.length === 0 ? (
          <EmptyState>{q || stage ? 'No companies match.' : 'No companies yet. Convert a lead, or add one above.'}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Company</Th><Th>Stage</Th><Th>Owner</Th><Th>Last activity</Th></tr></thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.id}>
                  <Td>
                    <Link href={`/companies/${company.id}`} className="font-medium hover:underline">{company.name}</Link>
                    {company.website && <div className="text-xs text-neutral-500">{company.website.replace(/^https?:\/\//, '')}</div>}
                  </Td>
                  <Td><span className="flex gap-1"><LifecycleBadge stage={company.lifecycleStage} />{company.archivedAt && <ArchivedBadge />}</span></Td>
                  <Td className="text-neutral-600">{members.nameOf(company.ownerId)}</Td>
                  <Td className="whitespace-nowrap text-neutral-500">{formatDate(company.lastActivityAt, settings.timezone)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager
          base="/companies"
          params={{ ...base, ...(stage ? { stage } : {}), ...(includeArchived ? { archived: 'true' } : {}) }}
          cursor={cursor}
          nextCursor={nextCursor}
        />
      </Card>
    </div>
  )
}
