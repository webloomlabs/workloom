import { minorToDecimalString, type Permission } from '@workloom/core'
import {
  ATTACHMENT_MAX_BYTES,
  attachmentList,
  commentList,
  companyList,
  documentList,
  expenseList,
  milestoneList,
  projectGet,
  projectFinancials,
  projectMemberList,
  taskList,
  timeEntryList,
  timeEntrySummary,
} from '@workloom/core/modules'
import { formatDuration } from '@workloom/core/time'
import { Alert, Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArchivedBadge } from '@/components/crm/badges'
import { param } from '@/components/crm/list-controls'
import { SectionTabs, type SectionTab } from '@/components/crm/section-tabs'
import { BlockedBadge, PriorityBadge, ProgressBar, ProjectStatusBadge } from '@/components/projects/badges'
import { CommentForm, CommentList, FileList, UploadForm } from '@/components/projects/discussion'
import {
  AddMemberForm,
  CreateMilestoneForm,
  EditProjectForm,
  MemberControls,
  MilestoneControls,
  ProjectArchiveControl,
  ProjectStatusControl,
} from '@/components/projects/project-forms'
import { QuickTaskForm, TaskStatusControl } from '@/components/projects/task-forms'
import { EntryControls, LogTimeForm } from '@/components/time/time-forms'
import { label as labelOf } from '@/lib/crm-labels'
import { DOCUMENT_CATEGORY_LABELS } from '@/lib/service-labels'
import { DeleteDocumentButton, DocumentVisibilityToggle, UploadDocumentForm } from '@/components/service/document-forms'
import { formatBytes, formatDate, formatDateTime, todayIn } from '@/lib/format'
import { PRIORITY_RANK, TASK_STATUS_LABELS } from '@/lib/project-labels'
import { memberChoices, money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Project · Workloom' }

type Project = Awaited<ReturnType<typeof loadProject>>
const loadProject = (id: string) => call(projectGet, { id })

type Context = {
  project: Project
  can: (permission: Permission) => boolean
  /** The person viewing: the user, or an API key's owner. */
  selfId: string | null
  timezone: string
  members: Awaited<ReturnType<typeof memberChoices>>
}

const TABS = ['tasks', 'milestones', 'time', 'financials', 'team', 'updates', 'files', 'details'] as const
type Tab = (typeof TABS)[number]

export default async function ProjectPage({ params, searchParams }: PageProps<'/projects/[id]'>) {
  const { id } = await params
  const query = await searchParams
  const viewer = await requireViewer()
  const can = (p: Permission) => viewer.permissions.has(p)

  const [project, members, settings] = await Promise.all([loadProject(id), memberChoices(), organizationSettings()])
  const active: Tab = TABS.find((t) => t === param(query.tab)) ?? 'tasks'
  const selfId = viewer.actor.type === 'user' ? viewer.actor.id : viewer.actor.type === 'apiKey' ? viewer.actor.userId : null
  const context: Context = { project, can, selfId, timezone: settings.timezone, members }
  const base = `/projects/${id}`

  const labels: Record<Tab, string> = { tasks: 'Tasks', milestones: 'Milestones', time: 'Time', financials: 'Financials', team: 'Team', updates: 'Updates', files: 'Files', details: 'Details' }
  const visible: Partial<Record<Tab, Permission>> = { milestones: 'milestone:read', time: 'timeEntry:read', financials: 'report:readFinancial' }
  const tabs: SectionTab[] = TABS.filter((t) => !visible[t] || can(visible[t])).map((t) => ({
    key: t,
    label: labels[t],
    status: 'available',
    href: t === 'tasks' ? base : `${base}?tab=${t}`,
    ...(t === 'tasks' ? { count: project.progress.tasksTotal } : t === 'milestones' ? { count: project.progress.milestonesTotal } : {}),
  }))

  const content: Record<Tab, (ctx: Context) => Promise<ReactNode>> = { tasks: Tasks, milestones: Milestones, time: Time, financials: Financials, team: Team, updates: Updates, files: Files, details: Details }
  const live = !project.archivedAt

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/projects" className="text-sm text-muted hover:underline">← Projects</Link>}
        title={project.name}
        description={
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <ProjectStatusBadge status={project.status} />
              {project.archivedAt && <ArchivedBadge />}
              {project.companyId ? (
                <Link href={`/companies/${project.companyId}?tab=projects`} className="hover:underline">{project.companyName}</Link>
              ) : (
                <span>Internal</span>
              )}
              <span>{members.nameOf(project.ownerId)}</span>
              {project.dueDate && <span>Due {formatDate(project.dueDate)}</span>}
              {project.budgetMinor !== null && <span>Budget {money(project.budgetMinor, project.currency)}</span>}
            </div>
            <ProgressBar
              percent={project.progress.percent}
              detail={`${project.progress.tasksDone} of ${project.progress.tasksTotal} tasks done · ${project.progress.milestonesDone} of ${project.progress.milestonesTotal} milestones`}
            />
          </>
        }
        actions={
          live && can('project:update') && <ProjectStatusControl id={project.id} status={project.status} />
        }
      />

      {project.archivedAt && <Alert tone="warning">This project is archived. Restore it from Details to change anything.</Alert>}

      <SectionTabs tabs={tabs} active={active} label="Project sections" />
      {await content[active](context)}
    </div>
  )
}

async function Tasks({ project, can, members }: Context) {
  const [{ data: tasks }, milestones] = await Promise.all([
    call(taskList, { projectId: project.id, limit: 200 }),
    can('milestone:read') ? call(milestoneList, { id: project.id }) : { data: [] },
  ])
  const milestoneName = new Map(milestones.data.map((m) => [m.id, m.name]))
  const columns = ['todo', 'in_progress', 'in_review', 'done'] as const
  const cancelled = tasks.filter((t) => t.status === 'cancelled')
  const sorted = [...tasks].sort(
    (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'),
  )
  const canUpdate = can('task:update') && !project.archivedAt

  return (
    <div className="space-y-6">
      {can('task:create') && !project.archivedAt && (
        <Card className="p-5">
          <QuickTaskForm projectId={project.id} members={members.choices} milestones={milestones.data.filter((m) => !m.completedAt).map((m) => ({ id: m.id, name: m.name }))} />
        </Card>
      )}
      <div className="overflow-x-auto pb-2">
        <div className="grid min-w-[56rem] grid-cols-4 gap-3">
          {columns.map((status) => {
            const column = sorted.filter((t) => t.status === status)
            return (
              <section key={status} aria-labelledby={`column-${status}`} className="space-y-2">
                <h2 id={`column-${status}`} className="px-1 text-sm font-semibold">
                  {TASK_STATUS_LABELS[status]} <span className="font-normal text-muted">{column.length}</span>
                </h2>
                {column.length === 0 && (
                  <p className="rounded-md border border-dashed border-line-strong p-4 text-center text-xs text-faint">No tasks</p>
                )}
                {column.map((task) => (
                  <Card key={task.id} className="space-y-2 p-3">
                    <Link href={`/projects/${project.id}/tasks/${task.id}`} className="block text-sm font-medium hover:underline">{task.title}</Link>
                    <div className="flex flex-wrap gap-1">
                      <PriorityBadge priority={task.priority} />
                      <BlockedBadge count={task.openDependencies} />
                    </div>
                    <div className="space-y-0.5 text-xs text-muted">
                      <div>{task.assigneeName ?? 'Unassigned'}</div>
                      {task.dueDate && <div>Due {formatDate(task.dueDate)}</div>}
                      {task.milestoneId && <div>{milestoneName.get(task.milestoneId)}</div>}
                    </div>
                    {canUpdate && <TaskStatusControl id={task.id} projectId={project.id} status={task.status} compact />}
                  </Card>
                ))}
              </section>
            )
          })}
        </div>
      </div>
      {cancelled.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">{cancelled.length} cancelled</summary>
          <ul className="mt-2 space-y-1 pl-4">
            {cancelled.map((t) => (
              <li key={t.id}><Link href={`/projects/${project.id}/tasks/${t.id}`} className="hover:underline">{t.title}</Link></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

async function Milestones({ project, can }: Context) {
  const { data: milestones } = await call(milestoneList, { id: project.id })
  const live = !project.archivedAt
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Milestones" description="Progress counts the tasks under each, excluding cancelled ones." />
        {milestones.length === 0 ? (
          <EmptyState>No milestones yet.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Milestone</Th><Th>Due</Th><Th>Progress</Th><Th /></tr></thead>
            <tbody>
              {milestones.map((m) => (
                <Tr key={m.id}>
                  <Td>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={m.completedAt ? 'text-muted line-through' : 'font-medium'}>{m.name}</span>
                      {m.clientVisible && <span className="text-xs text-positive">Client-visible</span>}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{formatDate(m.dueDate)}</Td>
                  <Td><ProgressBar percent={m.completedAt ? 100 : m.percent} detail={`${m.tasksDone} of ${m.tasksTotal} tasks done`} /></Td>
                  <Td className="text-right">
                    {live && can('milestone:update') && (
                      <MilestoneControls id={m.id} projectId={project.id} completed={Boolean(m.completedAt)} canDelete={can('milestone:delete')} />
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {live && can('milestone:create') && (
        <Card>
          <CardHeader title="Add a milestone" />
          <div className="p-5"><CreateMilestoneForm projectId={project.id} canPublish={can('project:update')} /></div>
        </Card>
      )}
    </div>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string | undefined }) {
  return (
    <Card className="space-y-1 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {detail && <div className="text-xs text-muted">{detail}</div>}
    </Card>
  )
}

/**
 * What the project earned and what it cost.
 *
 * Every figure is derived from what was stored when it happened: time at the
 * rate it was logged at, revenue from the lines of issued invoices. Raising
 * someone's rate today moves none of it.
 */
async function Financials({ project, can }: Context) {
  const report = await call(projectFinancials, { id: project.id })
  // A contractor on a fixed fee usually also sends an invoice. Entering both
  // counts the same money twice, and this is the only place to catch it.
  const contractorSpend =
    report.currencies.some((f) => f.membersWithFixedFee > 0) && can('expense:read')
      ? (await call(expenseList, { projectId: project.id, category: 'contractor', limit: 1 })).data.length
      : 0

  return (
    <div className="space-y-6">
      {report.currencies.map((figures) => {
        const money_ = (minor: number) => money(minor, figures.currency)
        const negative = figures.marginMinor < 0
        return (
          <div key={figures.currency} className="space-y-4">
            {report.currencies.length > 1 && (
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{figures.currency}</h2>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Billed" value={money_(figures.billedMinor)} detail={`${money_(figures.collectedMinor)} collected`} />
              <Stat
                label="Cost"
                value={money_(figures.costMinor)}
                detail={
                  `${money_(figures.labourCostMinor)} time · ${money_(figures.expenseCostMinor)} expenses` +
                  (figures.fixedCostMinor > 0 ? ` · ${money_(figures.fixedCostMinor)} fixed fees` : '')
                }
              />
              <Stat
                label="Margin"
                value={money_(figures.marginMinor)}
                detail={figures.marginPercent === null ? 'Nothing billed yet' : `${figures.marginPercent}% of what was billed`}
              />
              <Stat
                label="To invoice"
                value={money_(figures.uninvoicedMinor)}
                detail="Billable time nobody has billed yet"
              />
            </div>

            {negative && figures.billedMinor > 0 && (
              <Alert tone="warning">This project has cost more than it has billed.</Alert>
            )}
            {figures.fixedCostMinor > 0 && contractorSpend > 0 && (
              <Alert tone="warning">
                Someone on this project is on a fixed fee, and there are also contractor expenses against it. If the fee and the contractor&rsquo;s
                invoice are the same money, it is being counted twice — keep one or the other.
              </Alert>
            )}
            {figures.entriesWithoutCostRate > 0 && (
              <Alert tone="info">
                {figures.entriesWithoutCostRate} time {figures.entriesWithoutCostRate === 1 ? 'entry has' : 'entries have'} no cost rate, so that
                time is missing from the cost above. Set rates in Settings, then re-log or correct those entries.
              </Alert>
            )}

            <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
              <Card>
                <CardHeader title="Profit and loss" description="Over the whole life of the project." />
                <dl className="space-y-2 p-5 text-sm" aria-label={`Profit and loss in ${figures.currency}`}>
                  <Row label="Billed, excluding tax" value={money_(figures.billedMinor)} />
                  <Row label="Time" value={`-${money_(figures.labourCostMinor)}`} />
                  {figures.fixedCostMinor > 0 && (
                    <Row
                      label={`Fixed fees (${figures.membersWithFixedFee} ${figures.membersWithFixedFee === 1 ? 'person' : 'people'})`}
                      value={`-${money_(figures.fixedCostMinor)}`}
                    />
                  )}
                  <Row label="Expenses" value={`-${money_(figures.expenseCostMinor)}`} />
                  <div className={`flex justify-between gap-4 border-t border-line pt-2 text-base font-semibold ${negative ? 'text-critical' : ''}`}>
                    <dt>Margin</dt>
                    <dd className="tabular-nums">{money_(figures.marginMinor)}</dd>
                  </div>
                  {figures.rebilledCostMinor > 0 && (
                    <p className="pt-2 text-xs text-muted">
                      {money_(figures.rebilledCostMinor)} of those expenses was rebilled to the client, so it appears in both lines above and only
                      the markup reaches the margin.
                    </p>
                  )}
                </dl>
              </Card>

              <Card>
                <CardHeader title="What the hours earned" />
                <dl className="space-y-2 p-5 text-sm" aria-label={`Hours in ${figures.currency}`}>
                  <Row label="Billable time" value={formatDuration(figures.billableSeconds)} />
                  <Row label="Unbillable time" value={formatDuration(figures.nonBillableSeconds)} />
                  <Row label="Billable share" value={figures.utilisationPercent === null ? '—' : `${figures.utilisationPercent}%`} />
                  <Row
                    label="Earned per hour tracked"
                    value={figures.effectiveHourlyMinor === null ? '—' : money_(figures.effectiveHourlyMinor)}
                  />
                  <Row label="Still owed" value={money_(figures.outstandingMinor)} />
                  {report.budgetMinor !== null && figures.currency === report.currency && (
                    <Row
                      label={`Budget of ${money_(report.budgetMinor)}`}
                      value={report.budgetUsedPercent === null ? '—' : `${report.budgetUsedPercent}% spent`}
                    />
                  )}
                </dl>
              </Card>
            </div>
          </div>
        )
      })}
      {report.currencies.length > 1 && (
        <p className="text-xs text-muted">
          Nothing above is converted between currencies: an exchange rate is recorded only on a document when it is issued, and tracked time is not
          a document.
        </p>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

async function Time({ project, can, selfId, timezone }: Context) {
  const everyone = can('timeEntryAll:read')
  const financial = can('report:readFinancial')
  const live = !project.archivedAt
  const [summary, { data: entries }, openTasks] = await Promise.all([
    everyone ? call(timeEntrySummary, { id: project.id }) : null,
    call(timeEntryList, { projectId: project.id, limit: 50 }),
    live && can('timeEntry:create') ? call(taskList, { projectId: project.id, open: true, limit: 200 }) : { data: [] },
  ])
  const value = (minor: number | null) => (minor === null ? '—' : money(minor, project.currency))

  return (
    <div className="space-y-6">
      {summary && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Tracked" value={formatDuration(summary.totals.seconds)} detail={summary.runningTimers > 0 ? `${summary.runningTimers} running, not yet counted` : undefined} />
            <Stat label="Billable" value={formatDuration(summary.totals.billableSeconds)} />
            {financial && (
              <Stat
                label="Billable value"
                value={value(summary.totals.billableValueMinor)}
                detail={summary.totals.unratedBillableSeconds > 0 ? `${formatDuration(summary.totals.unratedBillableSeconds)} billable time has no rate` : 'At the rates each entry was logged at'}
              />
            )}
            {financial && (
              <Stat
                label="Labour cost"
                value={value(summary.totals.costMinor)}
                detail={summary.totals.unratedCostSeconds > 0 ? `${formatDuration(summary.totals.unratedCostSeconds)} has no cost rate` : undefined}
              />
            )}
          </div>

          {summary.byPerson.length > 0 && (
            <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
              <Card>
                <CardHeader title="By person" />
                <Table>
                  <thead><tr><Th>Person</Th><Th className="text-right">Tracked</Th><Th className="text-right">Billable</Th>{financial && <Th className="text-right">Value</Th>}{financial && <Th className="text-right">Cost</Th>}</tr></thead>
                  <tbody>
                    {summary.byPerson.map((row) => (
                      <Tr key={row.userId}>
                        <Td>{row.name}</Td>
                        <Td className="text-right tabular-nums">{formatDuration(row.seconds)}</Td>
                        <Td className="text-right tabular-nums">{formatDuration(row.billableSeconds)}</Td>
                        {financial && <Td className="text-right tabular-nums">{value(row.billableValueMinor)}</Td>}
                        {financial && <Td className="text-right tabular-nums">{value(row.costMinor)}</Td>}
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
              <Card>
                <CardHeader title="By task" />
                <Table>
                  <thead><tr><Th>Task</Th><Th className="text-right">Estimate</Th><Th className="text-right">Tracked</Th></tr></thead>
                  <tbody>
                    {summary.byTask.map((row) => {
                      const over = row.estimateMinutes !== null && row.seconds > row.estimateMinutes * 60
                      return (
                        <Tr key={row.taskId ?? 'project'}>
                          <Td>
                            {row.taskId ? (
                              <Link href={`/projects/${project.id}/tasks/${row.taskId}`} className="hover:underline">{row.title}</Link>
                            ) : (
                              <span className="text-muted">No task</span>
                            )}
                          </Td>
                          <Td className="text-right tabular-nums text-muted">{row.estimateMinutes === null ? '—' : formatDuration(row.estimateMinutes * 60)}</Td>
                          <Td className={`text-right tabular-nums ${over ? 'font-medium text-critical' : ''}`}>{formatDuration(row.seconds)}</Td>
                        </Tr>
                      )
                    })}
                  </tbody>
                </Table>
              </Card>
            </div>
          )}
        </>
      )}

      {live && can('timeEntry:create') && (
        <Card>
          <CardHeader title="Log time" description="For work you didn't time. Timers start from a task or your timesheet." />
          <div className="p-5">
            <LogTimeForm
              groups={[{ projectId: project.id, projectName: project.name, tasks: openTasks.data.map((t) => ({ id: t.id, title: t.title })) }]}
              defaultDate={todayIn(timezone)}
            />
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title={everyone ? 'Recent time' : 'Your recent time'} />
        {entries.length === 0 ? (
          <EmptyState>No time logged on this project yet.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Date</Th>{everyone && <Th>Person</Th>}<Th>Work</Th><Th className="text-right">Time</Th><Th /></tr></thead>
            <tbody>
              {entries.map((e) => (
                <Tr key={e.id}>
                  <Td className="whitespace-nowrap text-muted">{formatDate(e.spentOn)}</Td>
                  {everyone && <Td>{e.userName}</Td>}
                  <Td>
                    <div>{e.taskId ? <Link href={`/projects/${project.id}/tasks/${e.taskId}`} className="hover:underline">{e.taskTitle}</Link> : <span className="text-muted">No task</span>}</div>
                    {e.description && <div className="text-xs text-muted">{e.description}</div>}
                    {!e.billable && <Badge>Not billable</Badge>}
                  </Td>
                  <Td className="text-right tabular-nums">{e.running ? <Badge tone="positive">Running</Badge> : formatDuration(e.durationSeconds!)}</Td>
                  <Td>
                    {live && (e.userId === selfId ? can('timeEntry:update') : can('timeEntryAll:manage')) && (
                      <EntryControls
                        entry={{ id: e.id, running: e.running, spentOn: e.spentOn, duration: e.running ? '' : formatDuration(e.durationSeconds!), description: e.description, billable: e.billable }}
                      />
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}

async function Team({ project, can, members }: Context) {
  const { data: team } = await call(projectMemberList, { id: project.id })
  const financial = can('report:readFinancial')
  const canEdit = can('project:update') && !project.archivedAt
  const onTeam = new Set(team.map((m) => m.userId))
  const rate = (minor: number | null) => (minor === null ? '' : minorToDecimalString(minor, project.currency))

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Team"
          description={
            financial
              ? `Rates are per hour in ${project.currency}, and override each person's defaults on this project only. A fixed fee replaces the hourly cost: their time then costs nothing per hour and the fee is counted once.`
              : undefined
          }
        />
        {team.length === 0 ? (
          <EmptyState>Nobody is on this project yet.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Person</Th><Th>Role</Th>{financial && <Th>Rates</Th>}<Th /></tr></thead>
            <tbody>
              {team.map((m) => (
                <Tr key={m.id}>
                  <Td>
                    <div className="font-medium">{m.name}</div>
                    <div className="text-xs text-muted">{m.email}</div>
                  </Td>
                  <Td className="text-muted">{m.role === 'manager' ? 'Manager' : 'Member'}</Td>
                  {financial && (
                    <Td className="whitespace-nowrap text-xs text-muted">
                      {m.billableRateMinor !== null ? `Bill ${money(m.billableRateMinor, project.currency)}/h` : 'Default bill rate'}
                      <br />
                      {/* A fixed fee replaces the hourly cost rather than sitting
                          beside it, because that is what it does to the books. */}
                      {m.fixedFeeMinor !== null
                        ? `Fixed ${money(m.fixedFeeMinor, project.currency)}`
                        : m.costRateMinor !== null
                          ? `Cost ${money(m.costRateMinor, project.currency)}/h`
                          : 'Default cost rate'}
                    </Td>
                  )}
                  <Td>
                    <MemberControls
                      member={{ ...m, billableRate: rate(m.billableRateMinor), costRate: rate(m.costRateMinor), fixedFee: rate(m.fixedFeeMinor) }}
                      projectId={project.id}
                      currency={project.currency}
                      financial={financial}
                      canEdit={canEdit}
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {canEdit && (
        <Card>
          <CardHeader title="Add someone" />
          <div className="p-5">
            <AddMemberForm projectId={project.id} people={members.choices.filter((p) => !onTeam.has(p.id))} currency={project.currency} financial={financial} />
          </div>
        </Card>
      )}
    </div>
  )
}

async function Updates({ project, can, timezone }: Context) {
  const { data } = await call(commentList, { projectId: project.id, limit: 100 })
  const returnTo = `/projects/${project.id}`
  return (
    <Card>
      <CardHeader title="Updates" description="Notes on the project as a whole. Mark one client-visible to share it once the client portal exists." />
      {can('comment:create') && !project.archivedAt && (
        <div className="border-b border-line p-5">
          <CommentForm projectId={project.id} returnTo={returnTo} canPublish={can('project:update')} placeholder="Post an update…" />
        </div>
      )}
      <CommentList
        projectId={project.id}
        returnTo={returnTo}
        comments={data.map((c) => ({ ...c, when: formatDateTime(c.createdAt, timezone) }))}
      />
    </Card>
  )
}

async function Files({ project, can, timezone }: Context) {
  const returnTo = `/projects/${project.id}`
  // Two different things, deliberately kept apart: working files that belong to
  // the project, and documents filed against the client that this project is
  // the subject of -- a proposal, a contract, a brief. The second are the
  // client's records and live in `client_documents`, so an internal project
  // with no client cannot have any.
  const [attachments, documents] = await Promise.all([
    call(attachmentList, { projectId: project.id }),
    project.companyId && can('document:read')
      ? call(documentList, { projectId: project.id, limit: 50 })
      : Promise.resolve({ data: [] as Awaited<ReturnType<typeof call<typeof documentList>>>['data'] }),
  ])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Files" description="Files for the project as a whole. Task files live on their tasks." />
        {can('project:update') && !project.archivedAt && (
          <div className="border-b border-line p-5">
            <UploadForm projectId={project.id} returnTo={returnTo} canPublish maxLabel={formatBytes(ATTACHMENT_MAX_BYTES)} />
          </div>
        )}
        <FileList
          projectId={project.id}
          returnTo={returnTo}
          files={attachments.data.map((f) => ({ ...f, size: formatBytes(f.sizeBytes), when: formatDateTime(f.createdAt, timezone) }))}
        />
      </Card>

      {project.companyId && can('document:read') && (
        <Card>
          <CardHeader
            title="Documents"
            description="Proposals, contracts and briefs filed against the client for this project. They also appear on the client's record."
          />
          {can('document:create') && !project.archivedAt && (
            <div className="border-b border-line p-5">
              <UploadDocumentForm companyId={project.companyId} projects={[]} projectId={project.id} />
            </div>
          )}
          {documents.data.length === 0 ? (
            <EmptyState>Nothing filed against this project yet.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Document</Th>
                  <Th>Category</Th>
                  <Th className="text-right">Size</Th>
                  <Th>Filed</Th>
                  <Th>Client can see</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {documents.data.map((document) => (
                  <Tr key={document.id}>
                    <Td>
                      <a href={`/files/documents/${document.id}`} className="font-medium hover:underline">{document.title}</a>
                      <div className="text-xs text-muted">{document.filename}</div>
                    </Td>
                    <Td className="text-muted">{labelOf(DOCUMENT_CATEGORY_LABELS, document.category)}</Td>
                    <Td className="whitespace-nowrap text-right tabular-nums text-muted">{formatBytes(document.sizeBytes)}</Td>
                    <Td className="whitespace-nowrap text-muted">
                      {formatDate(document.createdAt)}
                      {document.uploaderName ? ` · ${document.uploaderName}` : ''}
                    </Td>
                    <Td>
                      {can('document:update') ? (
                        <DocumentVisibilityToggle
                          id={document.id}
                          companyId={project.companyId!}
                          projectId={project.id}
                          clientVisible={document.clientVisible}
                        />
                      ) : (
                        <span className="text-sm text-muted">{document.clientVisible ? 'Yes' : 'No'}</span>
                      )}
                    </Td>
                    <Td className="text-right">
                      {can('document:delete') && (
                        <DeleteDocumentButton id={document.id} companyId={project.companyId!} projectId={project.id} />
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </div>
  )
}

async function Details({ project, can, members }: Context) {
  const financial = can('report:readFinancial')
  const companies = can('company:read') ? await call(companyList, { limit: 100 }) : { data: [] }
  const companyChoices = companies.data.map((c) => ({ id: c.id, name: c.name }))
  if (project.companyId && project.companyName && !companyChoices.some((c) => c.id === project.companyId)) {
    companyChoices.unshift({ id: project.companyId, name: project.companyName })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Details" />
        <div className="p-5">
          {can('project:update') && !project.archivedAt ? (
            <EditProjectForm
              project={{
                ...project,
                budget: project.budgetMinor === null ? '' : minorToDecimalString(project.budgetMinor, project.currency),
              }}
              members={members.choices}
              companies={companyChoices}
              financial={financial}
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm">{project.description ?? 'No description.'}</p>
          )}
        </div>
      </Card>
      {can('project:archive') && (
        <Card className="p-5">
          <ProjectArchiveControl id={project.id} archived={Boolean(project.archivedAt)} />
        </Card>
      )}
    </div>
  )
}

