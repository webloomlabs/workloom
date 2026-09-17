import { dealList, dealPipeline } from '@workloom/core/modules'
import { Card, PageHeader, buttonStyles } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DealStageControl } from '@/components/crm/record-forms'
import { DEAL_STAGE_LABELS } from '@/lib/crm-labels'
import { formatDate } from '@/lib/format'
import { memberChoices, money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Pipeline · Workloom' }

/** Won and lost columns show recent closes only; the board is for what is in play. */
const CLOSED_WITHIN_DAYS = 90
const PER_COLUMN = 50

export default async function PipelinePage() {
  const viewer = await requireViewer()
  const canMove = viewer.permissions.has('deal:update')

  const [{ stages }, members, ...columns] = await Promise.all([
    call(dealPipeline, { closedWithinDays: CLOSED_WITHIN_DAYS }),
    memberChoices(),
    ...(['qualified', 'proposal_sent', 'negotiation', 'won', 'lost'] as const).map((stage) =>
      call(dealList, { stage, limit: PER_COLUMN }),
    ),
  ])

  const cutoff = Date.now() - CLOSED_WITHIN_DAYS * 86_400_000

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline"
        description={`Open deals by stage. Won and lost show the last ${CLOSED_WITHIN_DAYS} days.`}
        actions={
          <div className="flex items-center gap-4">
            <Link href="/deals" className="text-sm font-medium hover:underline">All deals</Link>
            {viewer.permissions.has('deal:create') && (
              <Link href="/deals/new" className={buttonStyles()}>
                New deal
              </Link>
            )}
          </div>
        }
      />

      <div className="overflow-x-auto pb-2">
        <div className="grid min-w-[64rem] grid-cols-5 gap-3">
          {stages.map((summary, i) => {
            const deals = columns[i]!.data.filter((d) => !d.closedAt || d.closedAt.getTime() >= cutoff)
            return (
              <section key={summary.stage} aria-labelledby={`col-${summary.stage}`} className="space-y-2">
                <header className="px-1">
                  <h2 id={`col-${summary.stage}`} className="text-sm font-semibold">
                    {DEAL_STAGE_LABELS[summary.stage]} <span className="font-normal text-muted">{summary.count}</span>
                  </h2>
                  <p className="text-xs tabular-nums text-muted">
                    {summary.totals.length === 0 ? '—' : summary.totals.map((t) => money(t.valueMinor, t.currency)).join(' + ')}
                  </p>
                </header>
                {deals.length === 0 && (
                  <p className="rounded-md border border-dashed border-line-strong p-4 text-center text-xs text-faint">No deals</p>
                )}
                {deals.map((deal) => (
                  <Card key={deal.id} className="space-y-2 p-3">
                    <div>
                      <Link href={`/deals/${deal.id}`} className="text-sm font-medium hover:underline">{deal.name}</Link>
                      <div className="text-xs text-muted">{deal.companyName}</div>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="font-medium tabular-nums">{money(deal.valueMinor, deal.currency)}</span>
                      <span className="text-muted">
                        {deal.closedAt ? formatDate(deal.closedAt) : deal.expectedCloseDate ? `Close ${formatDate(deal.expectedCloseDate)}` : ''}
                      </span>
                    </div>
                    <div className="text-xs text-muted">{members.nameOf(deal.ownerId)}</div>
                    {canMove && <DealStageControl id={deal.id} stage={deal.stage} compact />}
                  </Card>
                ))}
                {columns[i]!.nextCursor && (
                  <Link href={`/deals?stage=${summary.stage}`} className="block px-1 text-xs text-muted hover:underline">
                    All {DEAL_STAGE_LABELS[summary.stage]?.toLowerCase()} deals →
                  </Link>
                )}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
