import { redirect } from 'next/navigation'
import { requireViewer } from '@/lib/server/viewer'

/**
 * The dashboard arrives in S9. Until then the home page sends people where
 * they can do something: sign-in, onboarding, or organization settings.
 */
export default async function Home() {
  await requireViewer()
  redirect('/settings/organization')
}
