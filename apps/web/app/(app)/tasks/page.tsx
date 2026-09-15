import { taskList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, param } from '@/components/crm/list-controls'
import { BlockedBadge, PriorityBadge } from '@/components/projects/badges'
import { TaskStatusControl } from '@/components/projects/task-forms'
import { formatDate, todayIn } from '@/lib/format'
import { PRIORITY_RANK } from '@/lib/project-labels'
import { organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'My tasks · Workloom' }

/** What is on my plate: open tasks assigned to me, most pressing first. */
export default async function MyTasksPage({ searchParams }: PageProps<'/tasks'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const showDone = param(query.show) === 'done'

  const [{ data }, settings] = await Promise.all([
    call(taskList, { mine: true, limit: 200, ...(showDone ? { status: 'done' as const } : { open: true }) }),
    organizationSettings(),
  ])
  const tasks = showDone
    ? data
    : [...data].sort(
        (a, b) =>
          (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
          (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9),
      )
  const today = todayIn(settings.timezone)
  const canUpdate = viewer.permissions.has('task:update')

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">My tasks</h1>
      <Card>
        <CardHeader
          title={showDone ? 'Recently done' : 'Open'}
          action={<FilterTabs active={showDone ? 'done' : 'open'} tabs={[{ key: 'open', label: 'Open', href: '/tasks' }, { key: 'done', label: 'Done', href: '/tasks?show=done' }]} />}
        />
        {tasks.length === 0 ? (
          <EmptyState>{showDone ? 'Nothing completed yet.' : 'Nothing assigned to you. Enjoy it.'}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Task</Th><Th>Project</Th><Th>Due</Th><Th>Status</Th></tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <Td>
                    <span className="flex flex-wrap items-center gap-2">
                      <Link href={`/projects/${t.projectId}/tasks/${t.id}`} className="font-medium hover:underline">{t.title}</Link>
                      <PriorityBadge priority={t.priority} />
                      <BlockedBadge count={t.openDependencies} />
                    </span>
                  </Td>
                  <Td><Link href={`/projects/${t.projectId}`} className="text-neutral-600 hover:underline">{t.projectName}</Link></Td>
                  <Td className={`whitespace-nowrap ${t.dueDate && t.dueDate < today && !showDone ? 'font-medium text-red-600' : 'text-neutral-500'}`}>
                    {formatDate(t.dueDate)}
                  </Td>
                  <Td>{canUpdate ? <TaskStatusControl id={t.id} projectId={t.projectId} status={t.status} /> : t.status}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
