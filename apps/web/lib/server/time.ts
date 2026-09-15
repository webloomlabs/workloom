import 'server-only'
import { projectList, taskList } from '@workloom/core/modules'
import type { WorkGroup } from '@/components/time/time-forms'
import { call } from './procedures.ts'

/** Active projects and their open tasks, for choosing where time goes. */
export async function workGroups(): Promise<WorkGroup[]> {
  const [projects, tasks] = await Promise.all([call(projectList, { active: true, limit: 100 }), call(taskList, { open: true, limit: 200 })])
  return projects.data
    .map((p) => ({
      projectId: p.id,
      projectName: p.name,
      tasks: tasks.data
        .filter((t) => t.projectId === p.id)
        .map((t) => ({ id: t.id, title: t.title }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName))
}
