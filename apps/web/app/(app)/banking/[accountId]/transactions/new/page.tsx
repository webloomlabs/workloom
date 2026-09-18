import { bankAccountGet } from '@workloom/core/modules'
import { Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CreateTransactionForm } from '@/components/banking/transaction-forms'
import { todayIn } from '@/lib/format'
import { organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Add transaction · Workloom' }

export default async function NewBankTransactionPage({ params }: PageProps<'/banking/[accountId]/transactions/new'>) {
  const { accountId } = await params
  await requireViewer()
  const [account, settings] = await Promise.all([call(bankAccountGet, { id: accountId }), organizationSettings()])

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={
          <Link href={`/banking/${accountId}`} className="text-sm text-muted hover:text-ink">
            ← {account.name}
          </Link>
        }
        title="Add transaction"
      />
      <Card>
        <CardHeader
          title="What the bank says moved"
          description="For a movement you know about before the statement arrives. Importing a statement file is the ordinary way in, and it will not duplicate a line entered here."
        />
        <div className="p-5">
          <CreateTransactionForm
            bankAccountId={account.id}
            currency={account.currency}
            today={todayIn(settings.timezone)}
          />
        </div>
      </Card>
    </div>
  )
}
