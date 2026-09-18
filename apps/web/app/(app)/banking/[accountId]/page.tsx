import { bankAccountGet, bankTransactionList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr, buttonStyles } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { BankStatusBadge } from '@/components/banking/badges'
import { AccountArchiveControl } from '@/components/banking/account-forms'
import { BANK_ACCOUNT_KIND_LABELS } from '@/lib/banking-labels'
import { label } from '@/lib/crm-labels'
import { formatDate } from '@/lib/format'
import { money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Account · Workloom' }

/**
 * One account's register: what the bank says moved, newest first.
 *
 * "To explain" is the default view rather than "All", because the register is
 * opened to clear that list, not to browse it.
 */
const VIEWS = {
  attention: { label: 'To explain', filter: { status: 'unexplained' as const } },
  all: { label: 'All', filter: {} },
  in: { label: 'Money in', filter: { direction: 'in' as const } },
  out: { label: 'Money out', filter: { direction: 'out' as const } },
  ignored: { label: 'Set aside', filter: { status: 'ignored' as const } },
}

export default async function BankAccountPage({ params, searchParams }: PageProps<'/banking/[accountId]'>) {
  const { accountId } = await params
  const query = await searchParams
  const viewer = await requireViewer()
  const view = (param(query.view) ?? 'attention') as keyof typeof VIEWS
  const { filter } = VIEWS[view] ?? VIEWS.attention
  const q = param(query.q)
  const cursor = param(query.cursor)

  const [account, lines] = await Promise.all([
    call(bankAccountGet, { id: accountId }),
    call(bankTransactionList, {
      bankAccountId: accountId,
      ...filter,
      ...(q ? { q } : {}),
      ...(cursor ? { cursor } : {}),
      limit: 50,
    }),
  ])

  const base = `/banking/${accountId}`
  const keep = { ...(view === 'attention' ? {} : { view }), ...(q ? { q } : {}) }

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/banking" className="text-sm text-muted hover:text-ink">← Banking</Link>}
        eyebrow={label(BANK_ACCOUNT_KIND_LABELS, account.kind)}
        title={account.name}
        description={[account.institution, account.accountIdentifier].filter(Boolean).join(' · ') || undefined}
        actions={
          viewer.permissions.has('bankTransaction:create') &&
          !account.archivedAt && (
            <Link href={`${base}/transactions/new`} className={buttonStyles()}>
              Add transaction
            </Link>
          )
        }
      />

      {/* The three numbers a person opens this page for. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <div className="text-sm text-muted">Balance</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${account.currentBalanceMinor < 0 ? 'text-critical' : ''}`}>
            {money(account.currentBalanceMinor, account.currency)}
          </div>
          <div className="mt-1 text-xs text-muted">
            Opened at {money(account.openingBalanceMinor, account.currency)} on {formatDate(account.openingBalanceOn)}
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-sm text-muted">Still to explain</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${account.unexplainedCount > 0 ? 'text-caution' : ''}`}>
            {account.unexplainedCount}
          </div>
          <div className="mt-1 text-xs text-muted">
            {account.oldestUnexplainedOn ? `Oldest ${formatDate(account.oldestUnexplainedOn)}` : 'Nothing outstanding'}
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-sm text-muted">Last reconciled</div>
          <div className="mt-1 text-2xl font-semibold">
            {account.lastReconciledOn ? formatDate(account.lastReconciledOn) : 'Never'}
          </div>
          <div className="mt-1 text-xs text-muted">Reconciling to a statement arrives in S12d.</div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title={VIEWS[view]?.label ?? 'To explain'}
          description={
            view === 'attention' && account.unexplainedCount === 0
              ? 'Nothing here needs you.'
              : 'Signed as the bank reports it: money in is positive, money out negative.'
          }
          action={
            <div className="flex flex-wrap items-center gap-3">
              <FilterTabs
                active={view}
                tabs={Object.entries(VIEWS).map(([key, v]) => ({
                  key,
                  label: v.label,
                  href: key === 'attention' ? base : `${base}?view=${key}`,
                }))}
              />
              <SearchBox
                action={base}
                q={q}
                hidden={view === 'attention' ? {} : { view }}
                placeholder="Narration or reference"
              />
            </div>
          }
        />
        {lines.data.length === 0 ? (
          <EmptyState>
            {q ? 'Nothing matches.' : view === 'attention' ? 'Every transaction on this account is explained.' : 'No transactions yet.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Description</Th>
                <Th>Status</Th>
                <Th className="text-right">Amount</Th>
                <Th className="text-right">Balance</Th>
              </tr>
            </thead>
            <tbody>
              {lines.data.map((line) => (
                <Tr key={line.id}>
                  <Td className="whitespace-nowrap text-muted">{formatDate(line.bookedOn)}</Td>
                  <Td>
                    <Link href={`/banking/transactions/${line.id}`} className="font-medium hover:underline">
                      {line.description}
                    </Link>
                    {(line.counterparty || line.reference) && (
                      <div className="text-xs text-muted">{[line.counterparty, line.reference].filter(Boolean).join(' · ')}</div>
                    )}
                  </Td>
                  <Td><BankStatusBadge status={line.status} /></Td>
                  {/* Money in reads positive and green; money out keeps its sign. */}
                  <Td className={`whitespace-nowrap text-right tabular-nums ${line.amountMinor < 0 ? 'text-critical' : 'text-positive'}`}>
                    {line.amountMinor > 0 ? '+' : ''}
                    {money(line.amountMinor, line.currency)}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums text-muted">
                    {line.runningBalanceMinor === null ? '—' : money(line.runningBalanceMinor, line.currency)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager base={base} params={keep} cursor={cursor} nextCursor={lines.nextCursor} />
      </Card>

      {viewer.permissions.has('bankAccount:update') && (
        <Card>
          <CardHeader
            title="Account settings"
            description="Closing an account keeps everything that went through it; nothing is deleted."
            action={
              <Link href={`/banking/accounts/${accountId}/edit`} className={buttonStyles({ variant: 'secondary', size: 'sm' })}>
                Edit account
              </Link>
            }
          />
          {viewer.permissions.has('bankAccount:archive') && (
            <div className="p-5 pt-0">
              <AccountArchiveControl id={account.id} archived={Boolean(account.archivedAt)} />
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
