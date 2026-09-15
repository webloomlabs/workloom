import { addDays } from '@workloom/core/time'
import { companyList, dealGet } from '@workloom/core/modules'
import { Card, CardHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { CreateQuoteForm } from '@/components/finance/finance-forms'
import { todayIn } from '@/lib/format'
import { organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'New quote · Workloom' }

export default async function NewQuotePage({ searchParams }: PageProps<'/quotes/new'>) {
  const query = await searchParams
  await requireViewer()
  const companyId = param(query.companyId) ?? null
  const dealId = param(query.dealId)
  const [companies, settings, deal] = await Promise.all([
    call(companyList, { limit: 100 }),
    organizationSettings(),
    dealId && /^[0-9a-f-]{36}$/.test(dealId) ? call(dealGet, { id: dealId }) : null,
  ])
  const back = deal ? `/deals/${deal.id}` : companyId ? `/companies/${companyId}?tab=quotes` : '/quotes'

  return (
    <div className="space-y-6">
      <div>
        <Link href={back} className="text-sm text-neutral-500 hover:underline">← Back</Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">New quote</h1>
      </div>
      <Card>
        <CardHeader title="Quote" description="It starts as a draft. Add lines next, then mark it as sent when it goes to the client." />
        <div className="p-5">
          <CreateQuoteForm
            companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
            companyId={companyId}
            deal={deal ? { id: deal.id, name: deal.name, companyName: deal.companyName } : null}
            currency={deal?.currency ?? settings.baseCurrency}
            validUntil={addDays(todayIn(settings.timezone), 30)}
          />
        </div>
      </Card>
    </div>
  )
}
