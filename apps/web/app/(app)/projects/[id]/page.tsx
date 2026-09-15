import { minorToDecimalString, type Permission } from '@workloom/core'
import {
  ATTACHMENT_MAX_BYTES,
  attachmentList,
  commentList,
  companyList,
  milestoneList,
  projectGet,
  projectMemberList,
  taskList,
} from '@workloom/core/modules'
import { Alert, Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
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
import { formatBytes, formatDate, formatDateTime } from '@/lib/format'
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
  timezone: string
  members: Awaited<ReturnType<typeof memberChoices>>
}

const TABS = ['tasks', 'milestones', 'team', 'updates', 'files', 'details'] as const
type Tab = (typeof TABS)[number]

export default async function ProjectPage({ params, searchParams }: PageProps<'/projects/[id]'>) {
  const { id } = await params
  const query = await searchParams
  const viewer = await requireViewer()
  const can = (p: Permission) => viewer.permissions.has(p)

  const [project, members, settings] = await Promise.all([loadProject(id), memberChoices(), organizationSettings()])
  const active: Tab = TABS.find((t) => t === param(query.tab)) ?? 'tasks'
  const context: Context = { project, can, timezone: settings.timezone, members }
  const base = `/projects/${id}`

  const labels: Record<Tab, string> = { tasks: 'Tasks', milestones: 'Milestones', team: 'Team', updates: 'Updates', files: 'Files', details: 'Details' }
  const tabs: SectionTab[] = TABS.filter((t) => t !== 'milestones' || can('milestone:read')).map((t) => ({
    key: t,
    label: labels[t],
    status: 'available',
    href: t === 'tasks' ? base : `${base}?tab=${t}`,
    ...(t === 'tasks' ? { count: project.progress.tasksTotal } : t === 'milestones' ? { count: project.progress.milestonesTotal } : {}),
  }))

  const content: Record<Tab, (ctx: Context) => Promise<ReactNode>> = { tasks: Tasks, milestones: Milestones, team: Team, updates: Updates, files: Files, details: Details }
  const live = !project.archivedAt

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link href="/projects" className="text-sm text-neutral-500 hover:underline">← Projects</Link>
          <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500">
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
        </div>
        {live && can('project:update') && <ProjectStatusControl id={project.id} status={project.status} />}
      </div>

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
                  {TASK_STATUS_LABELS[status]} <span className="font-normal text-neutral-500">{column.length}</span>
                </h2>
                {column.length === 0 && (
                  <p className="rounded-md border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-400 dark:border-neutral-700">No tasks</p>
                )}
                {column.map((task) => (
                  <Card key={task.id} className="space-y-2 p-3">
                    <Link href={`/projects/${project.id}/tasks/${task.id}`} className="block text-sm font-medium hover:underline">{task.title}</Link>
                    <div className="flex flex-wrap gap-1">
                      <PriorityBadge priority={task.priority} />
                      <BlockedBadge count={task.openDependencies} />
                    </div>
                    <div className="space-y-0.5 text-xs text-neutral-500">
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
          <summary className="cursor-pointer text-neutral-500">{cancelled.length} cancelled</summary>
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
                <tr key={m.id}>
                  <Td>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={m.completedAt ? 'text-neutral-500 line-through' : 'font-medium'}>{m.name}</span>
                      {m.clientVisible && <span className="text-xs text-green-700 dark:text-green-400">Client-visible</span>}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap text-neutral-500">{formatDate(m.dueDate)}</Td>
                  <Td><ProgressBar percent={m.completedAt ? 100 : m.percent} detail={`${m.tasksDone} of ${m.tasksTotal} tasks done`} /></Td>
                  <Td className="text-right">
                    {live && can('milestone:update') && (
                      <MilestoneControls id={m.id} projectId={project.id} completed={Boolean(m.completedAt)} canDelete={can('milestone:delete')} />
                    )}
                  </Td>
                </tr>
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
          description={financial ? `Rates are per hour in ${project.currency}, and override each person's defaults on this project only.` : undefined}
        />
        {team.length === 0 ? (
          <EmptyState>Nobody is on this project yet.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Person</Th><Th>Role</Th>{financial && <Th>Rates</Th>}<Th /></tr></thead>
            <tbody>
              {team.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <div className="font-medium">{m.name}</div>
                    <div className="text-xs text-neutral-500">{m.email}</div>
                  </Td>
                  <Td className="text-neutral-600">{m.role === 'manager' ? 'Manager' : 'Member'}</Td>
                  {financial && (
                    <Td className="whitespace-nowrap text-xs text-neutral-600">
                      {m.billableRateMinor !== null ? `Bill ${money(m.billableRateMinor, project.currency)}/h` : 'Default bill rate'}
                      <br />
                      {m.costRateMinor !== null ? `Cost ${money(m.costRateMinor, project.currency)}/h` : 'Default cost rate'}
                    </Td>
                  )}
                  <Td>
                    <MemberControls
                      member={{ ...m, billableRate: rate(m.billableRateMinor), costRate: rate(m.costRateMinor) }}
                      projectId={project.id}
                      currency={project.currency}
                      financial={financial}
                      canEdit={canEdit}
                    />
                  </Td>
                </tr>
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
        <div className="border-b border-neutral-200 p-5 dark:border-neutral-800">
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
  const { data } = await call(attachmentList, { projectId: project.id })
  const returnTo = `/projects/${project.id}`
  return (
    <Card>
      <CardHeader title="Files" description="Files for the project as a whole. Task files live on their tasks." />
      {can('project:update') && !project.archivedAt && (
        <div className="border-b border-neutral-200 p-5 dark:border-neutral-800">
          <UploadForm projectId={project.id} returnTo={returnTo} canPublish maxLabel={formatBytes(ATTACHMENT_MAX_BYTES)} />
        </div>
      )}
      <FileList
        projectId={project.id}
        returnTo={returnTo}
        files={data.map((f) => ({ ...f, size: formatBytes(f.sizeBytes), when: formatDateTime(f.createdAt, timezone) }))}
      />
    </Card>
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

