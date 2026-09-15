import { dealList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ArchivedBadge, DealStageBadge } from '@/components/crm/badges'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { DEAL_STAGE_LABELS } from '@/lib/crm-labels'
import { formatDate } from '@/lib/format'
import { memberChoices, money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Deals · Workloom' }

const STAGES = ['qualified', 'proposal_sent', 'negotiation', 'won', 'lost'] as const

/** Every deal, for when the pipeline board's columns are not enough. */
export default async function DealsPage({ searchParams }: PageProps<'/deals'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const q = param(query.q)
  const stage = STAGES.find((s) => s === param(query.stage))
  const cursor = param(query.cursor)

  const [{ data: deals, nextCursor }, members] = await Promise.all([
    call(dealList, { q, stage, cursor, limit: 50 }),
    memberChoices(),
  ])

  const base = q ? { q } : {}
  const tabs = [
    { key: 'all', label: 'All', href: `/deals?${new URLSearchParams(base)}` },
    ...STAGES.map((s) => ({ key: s, label: DEAL_STAGE_LABELS[s]!, href: `/deals?${new URLSearchParams({ ...base, stage: s })}` })),
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/pipeline" className="text-sm text-neutral-500 hover:underline">← Pipeline</Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Deals</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SearchBox action="/deals" q={q} hidden={stage ? { stage } : {}} placeholder="Deal or company" />
          {viewer.permissions.has('deal:create') && (
            <Link href="/deals/new" className="text-sm font-medium hover:underline">New deal</Link>
          )}
        </div>
      </div>

      <Card>
        <CardHeader title="Deals" action={<FilterTabs tabs={tabs} active={stage ?? 'all'} />} />
        {deals.length === 0 ? (
          <EmptyState>{q || stage ? 'No deals match.' : 'No deals yet.'}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Deal</Th><Th>Stage</Th><Th className="text-right">Value</Th><Th>Owner</Th><Th>Close</Th></tr></thead>
            <tbody>
              {deals.map((d) => (
                <tr key={d.id}>
                  <Td>
                    <Link href={`/deals/${d.id}`} className="font-medium hover:underline">{d.name}</Link>
                    <div className="text-xs text-neutral-500">{d.companyName}</div>
                  </Td>
                  <Td><span className="flex gap-1"><DealStageBadge stage={d.stage} />{d.archivedAt && <ArchivedBadge />}</span></Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">{money(d.valueMinor, d.currency)}</Td>
                  <Td className="text-neutral-600">{members.nameOf(d.ownerId)}</Td>
                  <Td className="whitespace-nowrap text-neutral-500">{formatDate(d.closedAt ?? d.expectedCloseDate)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager base="/deals" params={{ ...base, ...(stage ? { stage } : {}) }} cursor={cursor} nextCursor={nextCursor} />
      </Card>
    </div>
  )
}
