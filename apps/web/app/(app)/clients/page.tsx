import { clientList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { CreateCompanyForm } from '@/components/crm/record-forms'
import { formatDate } from '@/lib/format'
import { memberChoices, money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Clients · Workloom' }

/**
 * Clients are companies at the `client` stage (or that were). Prospects live in
 * the pipeline and the company directory, not here.
 */
export default async function ClientsPage({ searchParams }: PageProps<'/clients'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const q = param(query.q)
  const show = param(query.show)
  const lifecycleStage = show === 'former' ? 'former_client' : show === 'all' ? undefined : 'client'
  const cursor = param(query.cursor)

  const [{ data: clients, nextCursor }, members, settings] = await Promise.all([
    call(clientList, { q, lifecycleStage, cursor, limit: 50 }),
    memberChoices(),
    organizationSettings(),
  ])

  const base = q ? { q } : {}
  const tabs = [
    { key: 'current', label: 'Current', href: `/clients?${new URLSearchParams(base)}` },
    { key: 'former', label: 'Former', href: `/clients?${new URLSearchParams({ ...base, show: 'former' })}` },
    { key: 'all', label: 'All', href: `/clients?${new URLSearchParams({ ...base, show: 'all' })}` },
  ]
  const showDeals = clients.some((c) => c.openDeals !== null) || viewer.permissions.has('deal:read')
  const showContacts = viewer.permissions.has('contact:read')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Clients</h1>
        <SearchBox action="/clients" q={q} hidden={show ? { show } : {}} placeholder="Name or website" />
      </div>

      {viewer.permissions.has('company:create') && (
        <Card>
          <details>
            <summary className="cursor-pointer px-5 py-4 text-sm font-semibold">Add a client</summary>
            <div className="border-t border-neutral-200 p-5 dark:border-neutral-800">
              <p className="mb-4 text-sm text-neutral-500">
                Usually clients arrive by converting a lead or winning a deal. Add one directly for existing relationships.
              </p>
              <CreateCompanyForm
                members={members.choices}
                currentUserId={viewer.actor.type === 'user' ? viewer.actor.id : null}
                stage="client"
                submitLabel="Add client"
              />
            </div>
          </details>
        </Card>
      )}

      <Card>
        <CardHeader title="Clients" action={<FilterTabs tabs={tabs} active={show === 'former' || show === 'all' ? show : 'current'} />} />
        {clients.length === 0 ? (
          <EmptyState>
            {q ? 'No clients match.' : 'No clients yet. A company becomes a client when you win its deal, or convert a lead without one.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Client</Th>
                <Th>Client since</Th>
                {showDeals && <Th className="text-right">Open deals</Th>}
                {showContacts && <Th className="text-right">Contacts</Th>}
                <Th>Owner</Th>
                <Th>Last activity</Th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.id}>
                  <Td>
                    <Link href={`/companies/${client.id}`} className="font-medium hover:underline">{client.name}</Link>
                    <div className="text-xs text-neutral-500">
                      {client.lifecycleStage === 'former_client' ? 'Former client' : client.website?.replace(/^https?:\/\//, '')}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-neutral-600">{formatDate(client.becameClientAt, settings.timezone)}</Td>
                  {showDeals && (
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      {client.openDeals && client.openDeals.count > 0
                        ? client.openDeals.value.map((v) => money(v.valueMinor, v.currency)).join(' + ')
                        : '—'}
                      {client.openDeals && client.openDeals.count > 0 && (
                        <div className="text-xs text-neutral-500">{client.openDeals.count} open</div>
                      )}
                    </Td>
                  )}
                  {showContacts && <Td className="text-right tabular-nums">{client.contactCount ?? '—'}</Td>}
                  <Td className="text-neutral-600">{members.nameOf(client.ownerId)}</Td>
                  <Td className="whitespace-nowrap text-neutral-500">{formatDate(client.lastActivityAt, settings.timezone)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager base="/clients" params={{ ...base, ...(show ? { show } : {}) }} cursor={cursor} nextCursor={nextCursor} />
      </Card>
    </div>
  )
}
