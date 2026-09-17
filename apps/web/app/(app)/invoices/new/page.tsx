import { companyList, organizationGet } from '@workloom/core/modules'
import { Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { CreateInvoiceForm } from '@/components/finance/invoice-forms'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'New invoice · Workloom' }

export default async function NewInvoicePage({ searchParams }: PageProps<'/invoices/new'>) {
  const query = await searchParams
  await requireViewer()
  const companyId = param(query.companyId) ?? null
  const [companies, organization] = await Promise.all([call(companyList, { limit: 100 }), call(organizationGet, {})])

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={
          <Link href={companyId ? `/companies/${companyId}?tab=invoices` : '/invoices'} className="text-sm text-muted hover:text-ink">
            ← Back
          </Link>
        }
        title="New invoice"
      />
      <Card>
        <CardHeader
          title="Invoice"
          description="It starts as a draft: add lines, or bill tracked time, then issue it. An issued invoice cannot be changed."
        />
        <div className="p-5">
          <CreateInvoiceForm
            companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
            companyId={companyId}
            currency={organization.baseCurrency}
            paymentTermsDays={organization.paymentTermsDays}
          />
        </div>
      </Card>
    </div>
  )
}
