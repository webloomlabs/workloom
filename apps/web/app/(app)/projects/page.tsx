import { projectList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { ProgressBar, ProjectStatusBadge } from '@/components/projects/badges'
import { formatDate } from '@/lib/format'
import { memberChoices } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Projects · Workloom' }

const STATUSES = ['planning', 'in_progress', 'on_hold', 'review', 'completed', 'cancelled'] as const

export default async function ProjectsPage({ searchParams }: PageProps<'/projects'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const q = param(query.q)
  const show = param(query.show)
  const status = STATUSES.find((s) => s === show)
  const cursor = param(query.cursor)

  const [{ data: projects, nextCursor }, members] = await Promise.all([
    call(projectList, { q, cursor, limit: 50, ...(status ? { status } : show === 'all' ? {} : { active: true }) }),
    memberChoices(),
  ])

  const base = q ? { q } : {}
  const tab = (key: string, label: string) => ({ key, label, href: `/projects?${new URLSearchParams(key === 'active' ? base : { ...base, show: key })}` })
  const tabs = [tab('active', 'Active'), tab('planning', 'Planning'), tab('on_hold', 'On hold'), tab('completed', 'Completed'), tab('all', 'All')]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
        <div className="flex flex-wrap items-center gap-3">
          <SearchBox action="/projects" q={q} hidden={show ? { show } : {}} placeholder="Project name" />
          {viewer.permissions.has('project:create') && (
            <Link href="/projects/new" className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
              New project
            </Link>
          )}
        </div>
      </div>

      <Card>
        <CardHeader title="Projects" action={<FilterTabs tabs={tabs} active={status ?? (show === 'all' ? 'all' : 'active')} />} />
        {projects.length === 0 ? (
          <EmptyState>{q || show ? 'No projects match.' : 'No active projects. Start one for a client, or for internal work.'}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Project</Th><Th>Status</Th><Th>Progress</Th><Th>Owner</Th><Th>Due</Th></tr></thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <Link href={`/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                    <div className="text-xs text-neutral-500">{p.companyName ?? 'Internal'}</div>
                  </Td>
                  <Td><ProjectStatusBadge status={p.status} /></Td>
                  <Td><ProgressBar percent={p.progress.percent} detail={`${p.progress.tasksDone} of ${p.progress.tasksTotal} tasks done`} /></Td>
                  <Td className="text-neutral-600">{members.nameOf(p.ownerId)}</Td>
                  <Td className="whitespace-nowrap text-neutral-500">{formatDate(p.dueDate)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager base="/projects" params={{ ...base, ...(show ? { show } : {}) }} cursor={cursor} nextCursor={nextCursor} />
      </Card>
    </div>
  )
}
