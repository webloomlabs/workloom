import { bankAccountList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { TransferForm } from '@/components/banking/transfer-forms'
import { todayIn } from '@/lib/format'
import { organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Transfer between accounts · Workloom' }

export default async function NewBankTransferPage({ searchParams }: PageProps<'/banking/transfers/new'>) {
  const query = await searchParams
  await requireViewer()
  const from = param(query.from)
  const [accounts, settings] = await Promise.all([call(bankAccountList, { limit: 100 }), organizationSettings()])
  const back = from ? `/banking/${from}` : '/banking'

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={
          <Link href={back} className="text-sm text-muted hover:text-ink">
            ← {accounts.data.find((a) => a.id === from)?.name ?? 'Banking'}
          </Link>
        }
        title="Transfer between accounts"
      />
      <Card>
        <CardHeader
          title="Money moved between your own accounts"
          description="Takes it out of one account and puts it in the other, on the same day. A transfer is neither income nor spending, so neither side waits to be explained."
        />
        {accounts.data.length < 2 ? (
          <EmptyState>A transfer needs two open accounts. Add another account first.</EmptyState>
        ) : (
          <div className="p-5">
            <TransferForm
              accounts={accounts.data.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
              from={from}
              to={param(query.to)}
              today={todayIn(settings.timezone)}
            />
          </div>
        )}
      </Card>
    </div>
  )
}
