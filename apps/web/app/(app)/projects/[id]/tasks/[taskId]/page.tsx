import type { Permission } from '@workloom/core'
import { ATTACHMENT_MAX_BYTES, attachmentList, commentList, milestoneList, projectGet, taskGet, taskList, timeEntryList } from '@workloom/core/modules'
import { formatDuration } from '@workloom/core/time'
import { Alert, Badge, Card, CardHeader, PageHeader } from '@workloom/ui'
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
import { LogTimeForm, StartTimerForm } from '@/components/time/time-forms'
import { formatBytes, formatDate, formatDateTime, todayIn } from '@/lib/format'
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

  const [project, members, settings, milestones, siblings, comments, files, time] = await Promise.all([
    call(projectGet, { id: projectId }),
    memberChoices(),
    organizationSettings(),
    can('milestone:read') ? call(milestoneList, { id: projectId }) : { data: [] },
    call(taskList, { projectId, limit: 200 }),
    call(commentList, { projectId, taskId, limit: 100 }),
    call(attachmentList, { projectId, taskId }),
    can('timeEntry:read') ? call(timeEntryList, { taskId, limit: 100 }) : { data: [] },
  ])
  const tracked = time.data.reduce((sum, e) => sum + (e.durationSeconds ?? 0), 0)
  const running = time.data.find((e) => e.running && e.userId === (viewer.actor.type === 'user' ? viewer.actor.id : viewer.actor.type === 'apiKey' ? viewer.actor.userId : null))

  const live = !project.archivedAt
  const canUpdate = can('task:update') && live
  const returnTo = `/projects/${projectId}/tasks/${taskId}`
  const linked = new Set([task.id, ...task.dependencies.map((d) => d.id), ...task.dependents.map((d) => d.id)])
  const candidates = siblings.data.filter((t) => !linked.has(t.id) && t.status !== 'cancelled').map((t) => ({ id: t.id, name: t.title }))

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href={`/projects/${projectId}`} className="text-sm text-muted hover:underline">← {project.name}</Link>}
        title={task.title}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <TaskStatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
            <BlockedBadge count={task.openDependencies} />
            <span>{task.assigneeName ?? 'Unassigned'}</span>
            {task.dueDate && <span>· Due {formatDate(task.dueDate)}</span>}
            {task.labels.map((l) => (
              <span key={l} className="rounded bg-raised px-1.5 py-0.5 text-xs">{l}</span>
            ))}
          </div>
        }
        actions={
          <div className="flex items-start gap-2">
            {canUpdate && <TaskStatusControl id={task.id} projectId={projectId} status={task.status} />}
            {live && can('task:delete') && <DeleteTaskButton id={task.id} projectId={projectId} />}
          </div>
        }
      />

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
              <div className="border-b border-line p-5">
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
              <div className="border-b border-line p-5">
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
          {can('timeEntry:read') && (
            <Card>
              <CardHeader
                title="Time"
                description={`${formatDuration(tracked)} ${can('timeEntryAll:read') ? 'tracked' : 'tracked by you'}${task.estimateMinutes !== null ? ` of ${formatDuration(task.estimateMinutes * 60)} estimated` : ''}`}
              />
              <div className="space-y-4 p-5">
                {live && can('timeEntry:create') && (
                  <>
                    {running ? (
                      <p className="flex items-center gap-2 text-sm"><Badge tone="positive">Running</Badge> Your timer is on this task. Stop it from the header.</p>
                    ) : (
                      <StartTimerForm work={`task:${task.id}`} />
                    )}
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted">Log time by hand</summary>
                      <div className="pt-3"><LogTimeForm work={`task:${task.id}`} defaultDate={todayIn(settings.timezone)} /></div>
                    </details>
                  </>
                )}
                {time.data.length > 0 && (
                  <ul className="space-y-1 border-t border-line pt-3 text-sm">
                    {time.data.slice(0, 10).map((e) => (
                      <li key={e.id} className="flex justify-between gap-2">
                        <span className="min-w-0 truncate text-muted">
                          {formatDate(e.spentOn)} · {e.userName}{e.description ? ` · ${e.description}` : ''}
                        </span>
                        <span className="tabular-nums">{e.running ? 'Running' : formatDuration(e.durationSeconds!)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Waits on" description="This task cannot be completed until these are done or cancelled." />
            <div className="space-y-4 p-5">
              {task.dependencies.length === 0 ? (
                <p className="text-sm text-muted">Nothing.</p>
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
