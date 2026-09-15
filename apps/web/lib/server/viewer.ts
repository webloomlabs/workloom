import 'server-only'
import { auth, resolveActor, type Resolution } from '@workloom/auth'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { cache } from 'react'

type Viewer = Extract<Resolution, { ok: true }>

/** The signed-in session, or null. Deduplicated per request. */
export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }))

const resolveViewer = cache(async () => resolveActor({ headers: await headers() }))

/**
 * The acting user and organization, or null -- for layouts that render around
 * pages which may have no organization yet, such as onboarding.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const resolution = await resolveViewer()
  return resolution.ok ? resolution : null
})

/**
 * The acting user and organization, or a redirect to wherever they need to go
 * next.
 *
 * This is for the UI's benefit only. Every data read and write still passes
 * through a procedure, which authorises independently -- so a page that forgot
 * to call this would show an error, not another organization's data.
 */
export const requireViewer = cache(async (): Promise<Viewer> => {
  const resolution = await resolveViewer()

  if (resolution.ok) return resolution
  if (resolution.reason === 'unauthenticated' || resolution.reason === 'invalid-key') {
    redirect('/sign-in')
  }
  // Signed in, but with no organization selected, or one they no longer
  // belong to: send them to choose or create one.
  redirect('/onboarding')
})

/**
 * Only same-origin relative paths are accepted as a post-sign-in destination.
 * Anything else -- `//evil.example`, `https://...`, `/\evil` -- falls back to
 * the home page, so the sign-in form cannot be used as an open redirect.
 */
export function safeRedirectPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string') return fallback
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback
  return value
}
