import { bankAccountGet } from '@workloom/core/modules'
import { Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { EditAccountForm } from '@/components/banking/account-forms'
import { organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Edit account · Workloom' }

export default async function EditBankAccountPage({ params }: PageProps<'/banking/accounts/[id]/edit'>) {
  const { id } = await params
  await requireViewer()
  const [account, settings] = await Promise.all([call(bankAccountGet, { id }), organizationSettings()])

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={
          <Link href={`/banking/${id}`} className="text-sm text-muted hover:text-ink">
            ← {account.name}
          </Link>
        }
        title="Edit account"
      />
      <Card>
        <CardHeader title="The account" />
        <div className="p-5">
          <EditAccountForm
            account={{
              id: account.id,
              name: account.name,
              kind: account.kind,
              currency: account.currency,
              institution: account.institution,
              accountIdentifier: account.accountIdentifier,
              openingBalanceMinor: account.openingBalanceMinor,
              openingBalanceOn: account.openingBalanceOn,
              isDefault: account.isDefault,
              // Movable until a period is reconciled against it.
              hasReconciled: account.lastReconciledOn !== null,
            }}
            baseCurrency={settings.baseCurrency}
          />
        </div>
      </Card>
    </div>
  )
}
