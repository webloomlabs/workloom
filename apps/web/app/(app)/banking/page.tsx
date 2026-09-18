import { bankAccountList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr, buttonStyles } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param } from '@/components/crm/list-controls'
import { UnexplainedBadge } from '@/components/banking/badges'
import { BANK_ACCOUNT_KIND_LABELS } from '@/lib/banking-labels'
import { label } from '@/lib/crm-labels'
import { formatDate } from '@/lib/format'
import { money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Banking · Workloom' }

/**
 * Where the money is.
 *
 * Two numbers per row carry the page: what is in the account, and how much of
 * it nobody has explained. The second is the one that says whether the books
 * are drifting, so it sits beside the balance rather than behind a report.
 */
const VIEWS = {
  open: { label: 'Open', filter: {} },
  attention: { label: 'Needs attention', filter: { needsAttention: true } },
  closed: { label: 'Closed', filter: { archived: true } },
}

export default async function BankingPage({ searchParams }: PageProps<'/banking'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const view = (param(query.view) ?? 'open') as keyof typeof VIEWS
  const { filter } = VIEWS[view] ?? VIEWS.open
  const cursor = param(query.cursor)

  const accounts = await call(bankAccountList, { ...filter, ...(cursor ? { cursor } : {}), limit: 50 })
  const outstanding = accounts.data.reduce((total, a) => total + a.unexplainedCount, 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Banking"
        description="The agency's own accounts, what is in them, and what the bank says moved that nobody has explained yet."
        actions={
          viewer.permissions.has('bankAccount:create') && (
            <Link href="/banking/accounts/new" className={buttonStyles()}>
              Add account
            </Link>
          )
        }
      />
      <Card>
        <CardHeader
          title={VIEWS[view]?.label ?? 'Open'}
          description={
            view === 'open' && outstanding > 0
              ? `${outstanding} transaction${outstanding === 1 ? '' : 's'} across these accounts still need explaining.`
              : undefined
          }
          action={
            <FilterTabs
              active={view}
              tabs={Object.entries(VIEWS).map(([key, v]) => ({
                key,
                label: v.label,
                href: key === 'open' ? '/banking' : `/banking?view=${key}`,
              }))}
            />
          }
        />
        {accounts.data.length === 0 ? (
          <EmptyState>
            {view === 'closed'
              ? 'No closed accounts.'
              : view === 'attention'
                ? 'Every transaction is explained. Nothing needs you.'
                : 'No accounts yet. Add one to start reconciling against a statement.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Kind</Th>
                <Th className="text-right">Balance</Th>
                <Th>To explain</Th>
                <Th>Last reconciled</Th>
              </tr>
            </thead>
            <tbody>
              {accounts.data.map((account) => (
                <Tr key={account.id}>
                  <Td>
                    <Link href={`/banking/${account.id}`} className="font-medium hover:underline">
                      {account.name}
                    </Link>
                    <div className="text-xs text-muted">
                      {[account.institution, account.accountIdentifier].filter(Boolean).join(' · ') || account.currency}
                    </div>
                  </Td>
                  <Td className="text-muted">{label(BANK_ACCOUNT_KIND_LABELS, account.kind)}</Td>
                  {/* A card sitting in credit is money owed, not money held. */}
                  <Td className={`whitespace-nowrap text-right tabular-nums ${account.currentBalanceMinor < 0 ? 'text-critical' : ''}`}>
                    {money(account.currentBalanceMinor, account.currency)}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <UnexplainedBadge count={account.unexplainedCount} />
                      {account.unexplainedCount === 0 && <span className="text-muted">—</span>}
                      {account.oldestUnexplainedOn && (
                        <span className="text-xs text-muted">since {formatDate(account.oldestUnexplainedOn)}</span>
                      )}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-muted">
                    {account.lastReconciledOn ? formatDate(account.lastReconciledOn) : 'Never'}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager base="/banking" params={view === 'open' ? {} : { view }} cursor={cursor} nextCursor={accounts.nextCursor} />
      </Card>
    </div>
  )
}
