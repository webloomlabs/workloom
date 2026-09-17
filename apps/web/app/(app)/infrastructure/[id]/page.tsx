import { companyList, infrastructureAssetGet, projectList } from '@workloom/core/modules'
import { Alert, Card, CardBody, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AssetStatusBadge, ExpiryBadge } from '@/components/service/badges'
import { DeleteAssetButton, EditAssetForm } from '@/components/service/asset-forms'
import { label } from '@/lib/crm-labels'
import { formatDate } from '@/lib/format'
import { ASSET_ENVIRONMENT_LABELS, ASSET_KIND_LABELS } from '@/lib/service-labels'
import { memberChoices, money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Infrastructure · Workloom' }

export default async function AssetPage({ params }: PageProps<'/infrastructure/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (permission: Parameters<typeof viewer.permissions.has>[0]) => viewer.permissions.has(permission)

  const asset = await call(infrastructureAssetGet, { id }).catch(() => null)
  if (!asset) notFound()

  const [companies, projects, members, settings] = await Promise.all([
    can('company:read') ? call(companyList, { limit: 100 }) : Promise.resolve({ data: [] }),
    can('project:read') ? call(projectList, { limit: 100 }) : Promise.resolve({ data: [] }),
    memberChoices(),
    organizationSettings(),
  ])

  const soon = asset.daysUntilExpiry !== null && asset.daysUntilExpiry <= 30

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/infrastructure" className="text-sm text-muted hover:text-ink">← Infrastructure</Link>}
        title={asset.name}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <AssetStatusBadge status={asset.status} />
            <ExpiryBadge days={asset.daysUntilExpiry} />
            <span>{label(ASSET_KIND_LABELS, asset.kind)}</span>
            <span>· {label(ASSET_ENVIRONMENT_LABELS, asset.environment)}</span>
            {asset.companyId ? (
              <Link href={`/companies/${asset.companyId}?tab=infrastructure`} className="hover:text-ink">· {asset.companyName}</Link>
            ) : (
              <span>· The agency&apos;s own</span>
            )}
            {asset.provider && <span>· {asset.provider}</span>}
          </div>
        }
        actions={can('infrastructure:delete') && <DeleteAssetButton id={asset.id} />}
      />

      {soon && asset.status !== 'decommissioned' && (
        <Alert tone={asset.daysUntilExpiry! < 0 ? 'error' : 'warning'}>
          {asset.daysUntilExpiry! < 0
            ? `This expired ${formatDate(asset.expiresOn)}. Anything depending on it is already at risk.`
            : `This renews ${formatDate(asset.expiresOn)}${asset.autoRenew ? ', and is set to renew itself — worth checking the card on file.' : '.'}`}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr] [&>*]:min-w-0">
        <Card>
          <CardHeader title="Details" />
          <CardBody className="space-y-2 text-sm">
            {[
              ['Address', asset.url ? <a key="url" href={asset.url} target="_blank" rel="noreferrer noopener" className="hover:underline">{asset.url}</a> : '—'],
              ['Renews or expires', asset.expiresOn ? formatDate(asset.expiresOn) : 'No date recorded'],
              ['Renews itself', asset.autoRenew ? 'Yes' : 'No'],
              ['Renewal cost', asset.renewalCostMinor !== null && asset.currency ? money(asset.renewalCostMinor, asset.currency) : '—'],
              ['Project', asset.projectId ? <Link key="p" href={`/projects/${asset.projectId}`} className="hover:underline">{asset.projectName}</Link> : '—'],
              ['Looked after by', asset.ownerName ?? 'Unassigned'],
            ].map(([term, value]) => (
              <div key={String(term)} className="flex justify-between gap-4">
                <dt className="text-muted">{term}</dt>
                <dd className="text-right text-ink">{value}</dd>
              </div>
            ))}
          </CardBody>
          {asset.notes && <CardBody className="border-t border-line whitespace-pre-wrap text-sm text-muted">{asset.notes}</CardBody>}
        </Card>

        {can('infrastructure:update') && (
          <Card>
            <CardHeader title="Edit" description="Moving the renewal date arms the warning again." />
            <CardBody>
              <EditAssetForm
                asset={asset}
                companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
                projects={projects.data.map((p) => ({ id: p.id, name: p.name }))}
                members={members.choices}
                baseCurrency={settings.baseCurrency}
              />
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  )
}
