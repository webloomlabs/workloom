import { minorToDecimalString } from '@workloom/core'
import { rateList } from '@workloom/core/modules'
import { Button, Card, CardHeader, Input, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import { param } from '@/components/crm/list-controls'
import { RateForm } from '@/components/time/time-forms'
import { money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Rates · Workloom' }

/**
 * Default hourly rates. Time takes the most specific rate that applies when it
 * is logged -- a project override, then the person's default, then the
 * organization's -- and keeps it.
 */
export default async function RatesPage({ searchParams }: PageProps<'/settings/rates'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const requested = param(query.currency)?.toUpperCase()
  const rates = await call(rateList, requested && /^[A-Z]{3}$/.test(requested) ? { currency: requested } : {})
  const canEdit = viewer.permissions.has('rate:update')
  const decimal = (minor: number | null) => (minor === null ? '' : minorToDecimalString(minor, rates.currency))
  const shown = (minor: number | null) => (minor === null ? '—' : `${money(minor, rates.currency)}/h`)

  const rows = [
    { userId: null, name: 'Organization default', detail: 'For anyone without their own rate', ...rates.organization },
    ...rates.members.map((m) => ({ ...m, detail: m.email })),
  ]

  return (
    <Card>
      <CardHeader
        title={`Hourly rates in ${rates.currency}`}
        description="Time logged on a project in this currency takes its rates from here, unless the project sets its own for that person. Changing a rate never changes time already logged."
        action={
          <form action="/settings/rates" className="flex items-center gap-2">
            <label htmlFor="rates-currency" className="sr-only">Currency</label>
            <div className="w-20"><Input id="rates-currency" name="currency" defaultValue={rates.currency} maxLength={3} className="h-8 text-xs uppercase" /></div>
            <Button type="submit" size="sm" variant="secondary">Show</Button>
          </form>
        }
      />
      <Table>
        <thead>
          <tr><Th>Who</Th>{canEdit ? <Th className="text-right">Billable / cost per hour</Th> : <><Th>Billable</Th><Th>Cost</Th></>}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.userId ?? 'organization'}>
              <Td>
                <div className="font-medium">{row.name}</div>
                <div className="text-xs text-muted">{row.detail}</div>
              </Td>
              {canEdit ? (
                <Td>
                  <RateForm
                    // A different currency is a different set of rates: start the row afresh.
                    key={rates.currency}
                    userId={row.userId}
                    name={row.name}
                    currency={rates.currency}
                    billableRate={decimal(row.billableRateMinor)}
                    costRate={decimal(row.costRateMinor)}
                  />
                </Td>
              ) : (
                <>
                  <Td className="tabular-nums">{shown(row.billableRateMinor)}</Td>
                  <Td className="tabular-nums">{shown(row.costRateMinor)}</Td>
                </>
              )}
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  )
}
