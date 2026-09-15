import { taxRateList } from '@workloom/core/modules'
import { Badge, Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import { FilterTabs, param } from '@/components/crm/list-controls'
import { CreateTaxRateForm, TaxRateControls } from '@/components/finance/finance-forms'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Tax rates · Workloom' }

export default async function TaxRatesPage({ searchParams }: PageProps<'/settings/tax-rates'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const can = (p: Parameters<typeof viewer.permissions.has>[0]) => viewer.permissions.has(p)
  const showArchived = param(query.show) === 'archived'
  const { data } = await call(taxRateList, { includeArchived: showArchived })
  const rates = showArchived ? data.filter((t) => t.archivedAt) : data

  return (
    <div className="space-y-6">
      {can('taxRate:create') && (
        <Card>
          <CardHeader title="Add a tax rate" description="A rate cannot change once a quote uses it. When the law changes, archive the old rate and add a new one." />
          <div className="p-5"><CreateTaxRateForm /></div>
        </Card>
      )}
      <Card>
        <CardHeader
          title="Tax rates"
          action={<FilterTabs active={showArchived ? 'archived' : 'live'} tabs={[{ key: 'live', label: 'In use', href: '/settings/tax-rates' }, { key: 'archived', label: 'Archived', href: '/settings/tax-rates?show=archived' }]} />}
        />
        {rates.length === 0 ? (
          <EmptyState>{showArchived ? 'Nothing archived.' : 'No tax rates yet.'}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th className="text-right">Rate</Th><Th>Description</Th><Th /></tr></thead>
            <tbody>
              {rates.map((t) => (
                <tr key={t.id}>
                  <Td><span className="font-medium">{t.name}</span> {t.archivedAt && <Badge tone="amber">Archived</Badge>}</Td>
                  <Td className="text-right tabular-nums">{t.rate}%</Td>
                  <Td className="text-neutral-600">{t.description}</Td>
                  <Td>
                    <TaxRateControls
                      taxRate={{ id: t.id, name: t.name, rate: t.rate, description: t.description, archived: Boolean(t.archivedAt) }}
                      canEdit={can('taxRate:update')}
                      canArchive={can('taxRate:archive')}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
