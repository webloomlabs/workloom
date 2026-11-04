import { bankTransactionGet, bankTransferGet } from '@workloom/core/modules'
import { Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { BankStatusBadge } from '@/components/banking/badges'
import {
  DeleteTransactionButton,
  EditTransactionForm,
  IgnoreTransactionControl,
} from '@/components/banking/transaction-forms'
import { DeleteTransferButton } from '@/components/banking/transfer-forms'
import { formatDate } from '@/lib/format'
import { todayIn } from '@/lib/format'
import { money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Transaction · Workloom' }

export default async function BankTransactionPage({ params }: PageProps<'/banking/transactions/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const [line, settings] = await Promise.all([call(bankTransactionGet, { id }), organizationSettings()])
  const reconciled = line.status === 'reconciled'
  const transfer = line.transferId ? await call(bankTransferGet, { id: line.transferId }) : null
  const other = transfer ? (transfer.from.id === line.id ? transfer.to : transfer.from) : null

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={
          <Link href={`/banking/${line.bankAccountId}`} className="text-sm text-muted hover:text-ink">
            ← {line.bankAccountName}
          </Link>
        }
        eyebrow={formatDate(line.bookedOn)}
        title={line.description}
        actions={<BankStatusBadge status={line.status} />}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <div className="text-sm text-muted">Amount</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${line.amountMinor < 0 ? 'text-critical' : 'text-positive'}`}>
            {line.amountMinor > 0 ? '+' : ''}
            {money(line.amountMinor, line.currency)}
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-sm text-muted">Explained</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{money(line.matchedMinor, line.currency)}</div>
          <div className="mt-1 text-xs text-muted">
            {line.unexplainedMinor === 0 ? 'Fully accounted for' : `${money(line.unexplainedMinor, line.currency)} left`}
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-sm text-muted">Counterparty</div>
          <div className="mt-1 text-lg font-medium">{line.counterparty ?? '—'}</div>
          <div className="mt-1 text-xs text-muted">{line.reference ? `Ref ${line.reference}` : 'No reference'}</div>
        </Card>
      </div>

      {transfer && other && (
        <Card>
          <CardHeader
            title={line.amountMinor < 0 ? 'Transfer out' : 'Transfer in'}
            description={`Money moved between your own accounts on ${formatDate(transfer.bookedOn)}. It is neither income nor spending: each side accounts for the other.`}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm">
              {line.amountMinor < 0 ? 'Arrived in ' : 'Came from '}
              <Link href={`/banking/transactions/${other.id}`} className="font-medium hover:underline">
                {other.bankAccountName}
              </Link>{' '}
              as <span className="tabular-nums">{money(Math.abs(other.amountMinor), other.currency)}</span>.
            </p>
            {!reconciled && viewer.permissions.has('bankTransaction:delete') && (
              <DeleteTransferButton id={transfer.id} bankAccountId={line.bankAccountId} />
            )}
          </div>
        </Card>
      )}

      {reconciled ? (
        <Card>
          <CardHeader
            title="Part of a completed reconciliation"
            description="This line is evidence that the books balanced on a date, so it can no longer change. Undo the reconciliation to reopen it."
          />
        </Card>
      ) : (
        <>
          {viewer.permissions.has('bankTransaction:update') && (
            <Card>
              <CardHeader title="The line" description="The narration is what ties this row back to the paper statement, so it is kept as the bank wrote it." />
              <div className="p-5">
                <EditTransactionForm
                  line={{
                    id: line.id,
                    bankAccountId: line.bankAccountId,
                    currency: line.currency,
                    amountMinor: line.amountMinor,
                    bookedOn: line.bookedOn,
                    valueOn: line.valueOn,
                    description: line.description,
                    counterparty: line.counterparty,
                    reference: line.reference,
                    notes: line.notes,
                    matchedMinor: line.matchedMinor,
                    transferId: line.transferId,
                  }}
                  today={todayIn(settings.timezone)}
                />
              </div>
            </Card>
          )}

          {!transfer && viewer.permissions.has('bankTransaction:reconcile') && (
            <Card>
              <CardHeader
                title="Set aside"
                description="For a line that is real but explains nothing — a bank error since reversed, or a transfer already recorded elsewhere."
              />
              <div className="p-5">
                <IgnoreTransactionControl
                  id={line.id}
                  bankAccountId={line.bankAccountId}
                  ignored={line.status === 'ignored'}
                  reason={line.ignoredReason}
                />
              </div>
            </Card>
          )}

          {!transfer && viewer.permissions.has('bankTransaction:delete') && line.matchedMinor === 0 && (
            <Card>
              <CardHeader
                title="Delete"
                description="Only for a line that should never have been there. Setting it aside keeps the register tied to the statement."
              />
              <div className="p-5">
                <DeleteTransactionButton id={line.id} bankAccountId={line.bankAccountId} />
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
