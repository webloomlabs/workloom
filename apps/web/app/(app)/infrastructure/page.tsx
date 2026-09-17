import { infrastructureAssetList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr, buttonStyles } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { AssetStatusBadge, ExpiryBadge } from '@/components/service/badges'
import { label } from '@/lib/crm-labels'
import { formatDate } from '@/lib/format'
import { ASSET_KIND_LABELS } from '@/lib/service-labels'
import { money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Infrastructure · Workloom' }

/**
 * What the agency runs, and when each piece next needs paying for.
 *
 * "Renewing soon" is the default view, because that is the question this
 * module exists to answer.
 */
const VIEWS = {
  renewing: { label: 'Renewing soon', filter: { expiringWithinDays: 60 } },
  domains: { label: 'Domains', filter: { kind: 'domain' as const } },
  hosting: { label: 'Hosting', filter: { kind: 'hosting' as const } },
  internal: { label: 'Our own', filter: { internal: true } },
  all: { label: 'All', filter: {} },
}

export default async function InfrastructurePage({ searchParams }: PageProps<'/infrastructure'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const view = (param(query.view) ?? 'renewing') as keyof typeof VIEWS
  const { filter } = VIEWS[view] ?? VIEWS.renewing
  const q = param(query.q)
  const cursor = param(query.cursor)

  const assets = await call(infrastructureAssetList, {
    ...filter,
    ...(q ? { q } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 50,
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Infrastructure"
        description="Domains, hosting, servers, and certificates — and the renewal dates that take a client's site down when they pass."
        actions={
          viewer.permissions.has('infrastructure:create') && (
            <Link href="/infrastructure/new" className={buttonStyles()}>
              Add infrastructure
            </Link>
          )
        }
      />
      <Card>
        <CardHeader
          title={VIEWS[view]?.label ?? 'Renewing soon'}
          description={view === 'renewing' ? 'Anything expiring in the next 60 days, soonest first.' : undefined}
          action={
            <div className="flex flex-wrap items-center gap-3">
              <FilterTabs
                active={view}
                tabs={Object.entries(VIEWS).map(([key, v]) => ({
                  key,
                  label: v.label,
                  href: key === 'renewing' ? '/infrastructure' : `/infrastructure?view=${key}`,
                }))}
              />
              <SearchBox action="/infrastructure" q={q} hidden={view === 'renewing' ? {} : { view }} placeholder="Name or provider" />
            </div>
          }
        />
        {assets.data.length === 0 ? (
          <EmptyState>
            {view === 'renewing' && !q ? 'Nothing is due for renewal in the next 60 days.' : 'Nothing matches.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Kind</Th>
                <Th>Client</Th>
                <Th>Provider</Th>
                <Th>Status</Th>
                <Th>Renews</Th>
                <Th className="text-right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {assets.data.map((asset) => (
                <Tr key={asset.id}>
                  <Td>
                    <Link href={`/infrastructure/${asset.id}`} className="font-medium hover:underline">{asset.name}</Link>
                    {asset.url && <div className="text-xs text-muted">{asset.url.replace(/^https?:\/\//, '')}</div>}
                  </Td>
                  <Td className="text-muted">{label(ASSET_KIND_LABELS, asset.kind)}</Td>
                  <Td className="text-muted">
                    {asset.companyId ? (
                      <Link href={`/companies/${asset.companyId}?tab=infrastructure`} className="hover:underline">{asset.companyName}</Link>
                    ) : (
                      'Ours'
                    )}
                  </Td>
                  <Td className="text-muted">{asset.provider ?? '—'}</Td>
                  <Td><AssetStatusBadge status={asset.status} /></Td>
                  <Td className="whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className={asset.daysUntilExpiry !== null && asset.daysUntilExpiry < 0 ? 'text-critical' : 'text-muted'}>
                        {asset.expiresOn ? formatDate(asset.expiresOn) : '—'}
                      </span>
                      <ExpiryBadge days={asset.daysUntilExpiry} />
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums text-muted">
                    {asset.renewalCostMinor !== null && asset.currency ? money(asset.renewalCostMinor, asset.currency) : '—'}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager
          base="/infrastructure"
          params={{ ...(view === 'renewing' ? {} : { view }), ...(q ? { q } : {}) }}
          cursor={cursor}
          nextCursor={assets.nextCursor}
        />
      </Card>
    </div>
  )
}
