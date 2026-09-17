import type { Permission } from '@workloom/core'
import { timeEntryList } from '@workloom/core/modules'
import { addDays, formatDuration, weekDays } from '@workloom/core/time'
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Select, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { EntryControls, LogTimeForm, StartTimerForm } from '@/components/time/time-forms'
import { todayIn } from '@/lib/format'
import { memberChoices, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { workGroups } from '@/lib/server/time'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Timesheet · Workloom' }

const dayLabel = (date: string, style: 'short' | 'long' = 'short') =>
  new Intl.DateTimeFormat('en-AU', { weekday: style, day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))

/** A person's week: what they tracked, day by day, and where to log more. */
export default async function TimesheetPage({ searchParams }: PageProps<'/time'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const can = (p: Permission) => viewer.permissions.has(p)
  const self = viewer.actor.type === 'user' ? viewer.actor.id : viewer.actor.type === 'apiKey' ? viewer.actor.userId : null

  const settings = await organizationSettings()
  const today = todayIn(settings.timezone)
  const requestedWeek = param(query.week)
  const days = weekDays(requestedWeek && /^\d{4}-\d{2}-\d{2}$/.test(requestedWeek) ? requestedWeek : today)
  const requestedUser = param(query.user)
  const person = can('timeEntryAll:read') && requestedUser && /^[0-9a-f-]{36}$/.test(requestedUser) ? requestedUser : self
  const own = person === self

  const [{ data: entries }, people, groups] = await Promise.all([
    call(timeEntryList, { ...(own ? { mine: true } : { userId: person! }), from: days[0], to: days[6], limit: 500 }),
    can('timeEntryAll:read') ? memberChoices() : null,
    own && can('timeEntry:create') ? workGroups() : [],
  ])
  const canChange = own ? can('timeEntry:update') : can('timeEntryAll:manage')

  // The grid: one row per project and task, one column per day.
  const stopped = entries.filter((e) => !e.running)
  const rows = new Map<string, { label: string; href: string; byDay: Map<string, number>; total: number }>()
  for (const e of stopped) {
    const key = `${e.projectId}:${e.taskId ?? ''}`
    const row = rows.get(key) ?? {
      label: e.taskTitle ? `${e.projectName} · ${e.taskTitle}` : e.projectName,
      href: e.taskId ? `/projects/${e.projectId}/tasks/${e.taskId}` : `/projects/${e.projectId}`,
      byDay: new Map(),
      total: 0,
    }
    row.byDay.set(e.spentOn, (row.byDay.get(e.spentOn) ?? 0) + e.durationSeconds!)
    row.total += e.durationSeconds!
    rows.set(key, row)
  }
  const dayTotal = (day: string) => stopped.filter((e) => e.spentOn === day).reduce((sum, e) => sum + e.durationSeconds!, 0)
  const weekTotal = stopped.reduce((sum, e) => sum + e.durationSeconds!, 0)
  const billableTotal = stopped.filter((e) => e.billable).reduce((sum, e) => sum + e.durationSeconds!, 0)

  const link = (week: string) => `/time?week=${week}${own ? '' : `&user=${person}`}`
  const personName = own ? null : (people?.choices.find((p) => p.id === person)?.name ?? 'Former member')

  return (
    <div className="space-y-6">
      <PageHeader
        title={own ? 'My timesheet' : `${personName}'s timesheet`}
        description={
          <>
            Week of {dayLabel(days[0]!, 'long')} · <span aria-label="Week total">{formatDuration(weekTotal)}</span> tracked,{' '}
            {formatDuration(billableTotal)} billable
          </>
        }
        actions={
          <>
            {people && (
              <form action="/time" className="flex items-center gap-2">
                <input type="hidden" name="week" value={days[0]} />
                <label htmlFor="timesheet-person" className="sr-only">Person</label>
                <Select id="timesheet-person" name="user" defaultValue={person ?? ''} className="h-8 text-xs">
                  {people.choices.map((p) => (
                    <option key={p.id} value={p.id}>{p.id === self ? `${p.name} (you)` : p.name}</option>
                  ))}
                </Select>
                <Button type="submit" size="sm" variant="secondary">Show</Button>
              </form>
            )}
            <nav aria-label="Weeks" className="flex items-center gap-1 text-sm">
              <Link href={link(addDays(days[0]!, -7))} className="rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-ink">← Previous</Link>
              {!days.includes(today) && (
                <Link href={link(today)} className="rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-ink">This week</Link>
              )}
              <Link href={link(addDays(days[0]!, 7))} className="rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-ink">Next →</Link>
            </nav>
          </>
        }
      />

      {own && can('timeEntry:create') && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader title="Start a timer" description="Starting one stops any timer already running." />
            <div className="p-5">
              {groups.length === 0 ? <p className="text-sm text-muted">No active projects to track time on.</p> : <StartTimerForm groups={groups} />}
            </div>
          </Card>
          <Card>
            <CardHeader title="Log time" description="For work you didn't time." />
            <div className="p-5">
              {groups.length === 0 ? (
                <p className="text-sm text-muted">No active projects to log time on.</p>
              ) : (
                <LogTimeForm groups={groups} defaultDate={days.includes(today) ? today : days[0]!} />
              )}
            </div>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader title="Week" />
        {rows.size === 0 ? (
          <EmptyState>No time tracked this week.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Work</Th>
                {days.map((d) => (
                  <Th key={d} className={`text-right ${d === today ? 'text-ink' : ''}`}>{dayLabel(d)}</Th>
                ))}
                <Th className="text-right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {[...rows.values()].sort((a, b) => a.label.localeCompare(b.label)).map((row) => (
                <Tr key={row.href}>
                  <Td><Link href={row.href} className="hover:underline">{row.label}</Link></Td>
                  {days.map((d) => (
                    <Td key={d} className="text-right tabular-nums text-muted">{row.byDay.has(d) ? formatDuration(row.byDay.get(d)!) : ''}</Td>
                  ))}
                  <Td className="text-right font-medium tabular-nums">{formatDuration(row.total)}</Td>
                </Tr>
              ))}
              <Tr className="bg-raised">
                <Td className="font-medium">Total</Td>
                {days.map((d) => (
                  <Td key={d} className="text-right font-medium tabular-nums">{dayTotal(d) > 0 ? formatDuration(dayTotal(d)) : ''}</Td>
                ))}
                <Td className="text-right font-semibold tabular-nums">{formatDuration(weekTotal)}</Td>
              </Tr>
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Entries" />
        {entries.length === 0 ? (
          <EmptyState>Nothing yet.</EmptyState>
        ) : (
          <div className="divide-y divide-line">
            {days
              .filter((d) => entries.some((e) => e.spentOn === d))
              .map((d) => (
                <section key={d} aria-labelledby={`day-${d}`} className="px-5 py-4">
                  <h3 id={`day-${d}`} className="mb-2 flex justify-between text-sm font-semibold">
                    <span>{dayLabel(d, 'long')}</span>
                    <span className="tabular-nums">{formatDuration(dayTotal(d))}</span>
                  </h3>
                  <ul className="space-y-2">
                    {entries
                      .filter((e) => e.spentOn === d)
                      .map((e) => (
                        <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 text-sm">
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <Link href={e.taskId ? `/projects/${e.projectId}/tasks/${e.taskId}` : `/projects/${e.projectId}`} className="font-medium hover:underline">
                                {e.taskTitle ?? e.projectName}
                              </Link>
                              {e.taskTitle && <span className="text-xs text-muted">{e.projectName}</span>}
                              {e.running ? <Badge tone="positive">Running</Badge> : null}
                              {!e.billable && <Badge>Not billable</Badge>}
                            </div>
                            {e.description && <p className="text-muted">{e.description}</p>}
                          </div>
                          <div className="flex items-start gap-3">
                            <span className="pt-1 font-medium tabular-nums">{e.running ? '—' : formatDuration(e.durationSeconds!)}</span>
                            {canChange && (
                              <EntryControls
                                entry={{ id: e.id, running: e.running, spentOn: e.spentOn, duration: e.running ? '' : formatDuration(e.durationSeconds!), description: e.description, billable: e.billable }}
                              />
                            )}
                          </div>
                        </li>
                      ))}
                  </ul>
                </section>
              ))}
          </div>
        )}
      </Card>
    </div>
  )
}
