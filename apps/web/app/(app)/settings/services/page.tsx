import { minorToDecimalString } from '@workloom/core'
import { serviceList, taxRateList } from '@workloom/core/modules'
import { Badge, Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import { FilterTabs, param } from '@/components/crm/list-controls'
import { CreateServiceForm, ServiceControls } from '@/components/finance/finance-forms'
import { label } from '@/lib/crm-labels'
import { BILLING_TYPE_LABELS, PRICING_MODEL_LABELS } from '@/lib/finance-labels'
import { money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Services · Workloom' }

export default async function ServicesPage({ searchParams }: PageProps<'/settings/services'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const can = (p: Parameters<typeof viewer.permissions.has>[0]) => viewer.permissions.has(p)
  const showArchived = param(query.show) === 'archived'
  const [{ data }, taxRates, settings] = await Promise.all([
    call(serviceList, { includeArchived: showArchived }),
    can('taxRate:read') ? call(taxRateList, {}) : { data: [] },
    organizationSettings(),
  ])
  const services = showArchived ? data.filter((s) => s.archivedAt) : data
  const taxChoices = taxRates.data.map((t) => ({ id: t.id, name: t.name, rate: t.rate }))

  return (
    <div className="space-y-6">
      {can('service:create') && (
        <Card>
          <CardHeader title="Add a service" description="What you sell. A quote line can start from a service instead of free text." />
          <div className="p-5"><CreateServiceForm taxRates={taxChoices} currency={settings.baseCurrency} /></div>
        </Card>
      )}
      <Card>
        <CardHeader
          title="Service catalogue"
          action={<FilterTabs active={showArchived ? 'archived' : 'live'} tabs={[{ key: 'live', label: 'Offered', href: '/settings/services' }, { key: 'archived', label: 'Archived', href: '/settings/services?show=archived' }]} />}
        />
        {services.length === 0 ? (
          <EmptyState>{showArchived ? 'Nothing archived.' : 'No services yet.'}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Service</Th><Th>Pricing</Th><Th className="text-right">Standard price</Th><Th>Default tax</Th><Th /></tr></thead>
            <tbody>
              {services.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    <div className="font-medium">{s.name} {s.archivedAt && <Badge tone="caution">Archived</Badge>}</div>
                    {s.description && <div className="text-xs text-muted">{s.description}</div>}
                  </Td>
                  <Td className="text-muted">{label(PRICING_MODEL_LABELS, s.pricingModel)} · {label(BILLING_TYPE_LABELS, s.billingType)}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {s.defaultPriceMinor === null ? '—' : `${money(s.defaultPriceMinor, s.currency)}${s.unit ? ` / ${s.unit}` : ''}`}
                  </Td>
                  <Td className="text-muted">{s.defaultTaxRateName ?? '—'}</Td>
                  <Td>
                    <ServiceControls
                      service={{ ...s, defaultPrice: s.defaultPriceMinor === null ? '' : minorToDecimalString(s.defaultPriceMinor, s.currency) }}
                      taxRates={taxChoices}
                      canEdit={can('service:update')}
                      canArchive={can('service:archive')}
                      archived={Boolean(s.archivedAt)}
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
