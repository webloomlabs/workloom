import { booksGet, taxPackList, taxPackPreflight } from '@workloom/core/modules'
import { Alert, Badge, Card, CardHeader, EmptyState, PageHeader, Stat, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { LockBooksForm, RequestPackForm, UnlockBooksForm } from '@/components/books-forms'
import { formatDate, formatDateTime } from '@/lib/format'
import { money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Income tax pack · Workloom' }

/** Where to go to fix what a warning is about. */
const FIX: Record<string, { href: string; label: string }> = {
  draft_invoices: { href: '/invoices?view=draft', label: 'Draft invoices' },
  draft_expenses: { href: '/expenses?view=drafts', label: 'Drafts to check' },
  missing_receipts: { href: '/expenses?view=noReceipt', label: 'Expenses missing a receipt' },
}

const STATUS = { pending: 'Being made', ready: 'Ready', failed: 'Failed' } as const

export default async function TaxPackPage({ searchParams }: PageProps<'/reports/tax'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const books = await call(booksGet, {})
  // The year to file is usually the one just finished.
  const requested = Number(param(query.year))
  const year = books.years.find((y) => y.startYear === requested) ?? books.years[1] ?? books.currentYear
  const [preflight, packs] = await Promise.all([call(taxPackPreflight, { startYear: year.startYear }), call(taxPackList, {})])
  const base = (minor: number) => money(minor, books.currency)
  const canLock = viewer.permissions.has('books:lock')
  const yearOver = year.to < books.today
  const lockedForYear = books.booksLockedThrough !== null && books.booksLockedThrough >= year.to

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/reports" className="text-sm text-muted hover:text-ink">← Reports</Link>}
        title="Income tax pack"
        description="A year's books for whoever prepares the return: profit and loss, every invoice, payment and expense, and the receipts — in one zip."
        actions={
          <nav aria-label="Financial year" className="flex flex-wrap gap-2 text-sm">
            {books.years.map((y) => (
              <Link
                key={y.startYear}
                href={`/reports/tax?year=${y.startYear}`}
                aria-current={y.startYear === year.startYear ? 'page' : undefined}
                className={y.startYear === year.startYear ? 'font-semibold text-ink underline' : 'text-muted hover:text-ink'}
              >
                {y.label}
              </Link>
            ))}
          </nav>
        }
      />

      <Card>
        <CardHeader title={`Year of assessment ${preflight.label}`} description={`${formatDate(preflight.from)} to ${formatDate(preflight.to)}, on the accrual basis, in ${books.currency}, before tax.`} />
        <section aria-label="The year's figures" className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Income" value={base(preflight.summary.income)} detail={`${preflight.summary.invoices} invoice(s)`} />
          <Stat label="Deductible expenses" value={base(preflight.summary.deductible)} detail={`${preflight.summary.expenses} expense(s)`} />
          <Stat label="Profit in the accounts" value={base(preflight.summary.accountingProfit)} detail={preflight.summary.nonDeductible > 0 ? `${base(preflight.summary.nonDeductible)} not deductible` : 'all expenses deductible'} />
          <Stat label="Capital spending" value={base(preflight.summary.capital)} detail="claimed through allowances" />
        </section>
        <div className="space-y-3 border-t border-line p-5">
          {preflight.warnings.length === 0 ? (
            <Alert tone="success">Nothing to check: no drafts, every expense has its receipt, and the books are closed for the year.</Alert>
          ) : (
            <Alert tone="warning">
              <p className="font-medium">Check before filing</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {preflight.warnings.map((w) => (
                  <li key={w.code}>
                    {w.message} {FIX[w.code] && <Link href={FIX[w.code]!.href} className="underline">{FIX[w.code]!.label}</Link>}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          <RequestPackForm startYear={year.startYear} label={preflight.label} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Packs" description="Each is a zip: README with the figures and checksums, the schedules as CSV, and the receipts named by expense." />
        {packs.data.length === 0 ? (
          <EmptyState>No packs yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr><Th>Year</Th><Th>Asked for</Th><Th>Status</Th><Th className="text-right">Income</Th><Th /></tr>
            </thead>
            <tbody>
              {packs.data.map((p) => (
                <Tr key={p.id}>
                  <Td className="font-medium">{p.label}</Td>
                  <Td className="text-muted">{formatDateTime(p.requestedAt)}</Td>
                  <Td>
                    <Badge tone={p.status === 'ready' ? 'positive' : p.status === 'failed' ? 'critical' : 'caution'}>{STATUS[p.status]}</Badge>
                    {p.status === 'ready' && p.warnings.length > 0 && <span className="ml-2 text-xs text-muted">{p.warnings.length} note(s) in the README</span>}
                    {p.error && <span className="ml-2 text-xs text-muted">{p.error}</span>}
                  </Td>
                  <Td className="text-right tabular-nums">{p.summary ? base(p.summary.income) : '—'}</Td>
                  <Td className="text-right">
                    {p.status === 'ready' && <a href={`/reports/tax/${p.id}/download`} className="text-sm font-medium hover:underline">Download</a>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Closing the books"
          description={
            books.booksLockedThrough
              ? `Closed through ${formatDate(books.booksLockedThrough)}: invoices, payments, and expenses dated on or before it cannot be added, changed, or removed.`
              : 'Open: anything can still be entered or changed for any date.'
          }
        />
        <div className="space-y-6 p-5">
          {!canLock ? (
            <p className="text-sm text-muted">An owner or admin closes and reopens the books.</p>
          ) : (
            <>
              {yearOver && !lockedForYear && <LockBooksForm through={year.to} />}
              {!yearOver && <p className="text-sm text-muted">{preflight.label} is not over yet; it can be closed after {formatDate(year.to)}.</p>}
              {books.booksLockedThrough && <UnlockBooksForm lockedThrough={books.booksLockedThrough} />}
            </>
          )}
        </div>
      </Card>
    </div>
  )
}
