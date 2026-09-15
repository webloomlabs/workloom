import { redirect } from 'next/navigation'
import { requireViewer } from '@/lib/server/viewer'

/**
 * The dashboard arrives in S9. Until then the home page sends people to the
 * most useful place their role can see.
 */
export default async function Home() {
  const viewer = await requireViewer()
  if (viewer.permissions.has('deal:read')) redirect('/pipeline')
  // Developers read companies too, but their day starts with their tasks.
  if (viewer.permissions.has('task:update')) redirect('/tasks')
  if (viewer.permissions.has('company:read')) redirect('/clients')
  redirect('/settings/organization')
}
