import type { Permission } from '@workloom/core'
import { ATTACHMENT_MAX_BYTES, attachmentList, commentList, milestoneList, projectGet, taskGet, taskList } from '@workloom/core/modules'
import { Alert, Card, CardHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { BlockedBadge, PriorityBadge, TaskStatusBadge } from '@/components/projects/badges'
import { CommentForm, CommentList, FileList, UploadForm } from '@/components/projects/discussion'
import {
  AddDependencyForm,
  DeleteTaskButton,
  EditTaskForm,
  RemoveDependencyButton,
  TaskStatusControl,
} from '@/components/projects/task-forms'
import { formatBytes, formatDate, formatDateTime } from '@/lib/format'
import { minutesToHours } from '@/lib/project-labels'
import { memberChoices, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Task · Workloom' }

export default async function TaskPage({ params }: PageProps<'/projects/[id]/tasks/[taskId]'>) {
  const { id: projectId, taskId } = await params
  const viewer = await requireViewer()
  const can = (p: Permission) => viewer.permissions.has(p)

  const task = await call(taskGet, { id: taskId })
  // The URL names the project too; a task under the wrong project is not here.
  if (task.projectId !== projectId) notFound()

  const [project, members, settings, milestones, siblings, comments, files] = await Promise.all([
    call(projectGet, { id: projectId }),
    memberChoices(),
    organizationSettings(),
    can('milestone:read') ? call(milestoneList, { id: projectId }) : { data: [] },
    call(taskList, { projectId, limit: 200 }),
    call(commentList, { projectId, taskId, limit: 100 }),
    call(attachmentList, { projectId, taskId }),
  ])

  const live = !project.archivedAt
  const canUpdate = can('task:update') && live
  const returnTo = `/projects/${projectId}/tasks/${taskId}`
  const linked = new Set([task.id, ...task.dependencies.map((d) => d.id), ...task.dependents.map((d) => d.id)])
  const candidates = siblings.data.filter((t) => !linked.has(t.id) && t.status !== 'cancelled').map((t) => ({ id: t.id, name: t.title }))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link href={`/projects/${projectId}`} className="text-sm text-neutral-500 hover:underline">← {project.name}</Link>
          <h1 className="text-xl font-semibold tracking-tight">{task.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-500">
            <TaskStatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
            <BlockedBadge count={task.openDependencies} />
            <span>{task.assigneeName ?? 'Unassigned'}</span>
            {task.dueDate && <span>· Due {formatDate(task.dueDate)}</span>}
            {task.labels.map((l) => (
              <span key={l} className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800">{l}</span>
            ))}
          </div>
        </div>
        <div className="flex items-start gap-2">
          {canUpdate && <TaskStatusControl id={task.id} projectId={projectId} status={task.status} />}
          {live && can('task:delete') && <DeleteTaskButton id={task.id} projectId={projectId} />}
        </div>
      </div>

      {task.openDependencies > 0 && task.status !== 'done' && (
        <Alert tone="warning">
          Waiting on {task.openDependencies} {task.openDependencies === 1 ? 'task' : 'tasks'}. It can be completed once they are done or cancelled.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Discussion" />
            {can('comment:create') && live && (
              <div className="border-b border-neutral-200 p-5 dark:border-neutral-800">
                <CommentForm projectId={projectId} taskId={taskId} returnTo={returnTo} canPublish={can('project:update')} placeholder="Add a comment…" />
              </div>
            )}
            <CommentList
              projectId={projectId}
              taskId={taskId}
              returnTo={returnTo}
              comments={comments.data.map((c) => ({ ...c, when: formatDateTime(c.createdAt, settings.timezone) }))}
            />
          </Card>

          <Card>
            <CardHeader title="Files" />
            {canUpdate && (
              <div className="border-b border-neutral-200 p-5 dark:border-neutral-800">
                <UploadForm projectId={projectId} taskId={taskId} returnTo={returnTo} canPublish={can('project:update')} maxLabel={formatBytes(ATTACHMENT_MAX_BYTES)} />
              </div>
            )}
            <FileList
              projectId={projectId}
              taskId={taskId}
              returnTo={returnTo}
              files={files.data.map((f) => ({ ...f, size: formatBytes(f.sizeBytes), when: formatDateTime(f.createdAt, settings.timezone) }))}
            />
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Waits on" description="This task cannot be completed until these are done or cancelled." />
            <div className="space-y-4 p-5">
              {task.dependencies.length === 0 ? (
                <p className="text-sm text-neutral-500">Nothing.</p>
              ) : (
                <ul className="space-y-1">
                  {task.dependencies.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex items-center gap-2">
                        <Link href={`/projects/${projectId}/tasks/${d.id}`} className="hover:underline">{d.title}</Link>
                        <TaskStatusBadge status={d.status} />
                      </span>
                      {canUpdate && <RemoveDependencyButton taskId={task.id} projectId={projectId} dependsOnTaskId={d.id} title={d.title} />}
                    </li>
                  ))}
                </ul>
              )}
              {canUpdate && <AddDependencyForm taskId={task.id} projectId={projectId} candidates={candidates} />}
            </div>
          </Card>

          {task.dependents.length > 0 && (
            <Card>
              <CardHeader title="Holding up" />
              <ul className="space-y-1 p-5">
                {task.dependents.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-sm">
                    <Link href={`/projects/${projectId}/tasks/${d.id}`} className="hover:underline">{d.title}</Link>
                    <TaskStatusBadge status={d.status} />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader title="Details" />
            <div className="p-5">
              {canUpdate ? (
                <EditTaskForm
                  task={{ ...task, estimateHours: minutesToHours(task.estimateMinutes) }}
                  members={members.choices}
                  milestones={milestones.data.map((m) => ({ id: m.id, name: m.name }))}
                  canPublish={can('project:update')}
                />
              ) : (
                <p className="whitespace-pre-wrap text-sm">{task.description ?? 'No description.'}</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
