import { companyList, organizationGet } from '@workloom/core/modules'
import { Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { RecordPaymentForm } from '@/components/finance/payment-forms'
import { todayIn } from '@/lib/format'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Record a payment · Workloom' }

export default async function NewPaymentPage({ searchParams }: PageProps<'/payments/new'>) {
  const query = await searchParams
  await requireViewer()
  const companyId = param(query.companyId) ?? null
  const [companies, organization] = await Promise.all([call(companyList, { limit: 100 }), call(organizationGet, {})])

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={
          <Link href={companyId ? `/companies/${companyId}?tab=payments` : '/payments'} className="text-sm text-muted hover:text-ink">
            ← Back
          </Link>
        }
        title="Record a payment"
      />
      <Card>
        <CardHeader
          title="Payment"
          description="Money received from a client. Put it against their invoices here or later; until then it sits on their account."
        />
        <div className="p-5">
          <RecordPaymentForm
            companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
            companyId={companyId}
            currency={organization.baseCurrency}
            baseCurrency={organization.baseCurrency}
            today={todayIn(organization.timezone)}
          />
        </div>
      </Card>
    </div>
  )
}
