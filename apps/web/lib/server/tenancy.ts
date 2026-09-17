import 'server-only'
import { isInstalled } from '@workloom/auth'
import { env } from '@workloom/config'
import { connection } from 'next/server'
import { cache } from 'react'

/**
 * Which shape this installation is running in.
 *
 * Every check here is a courtesy to the person using the product -- it decides
 * what the navigation offers, not what is permitted. Sign-up and organization
 * creation are closed in Better Auth itself, and `completeSetup` refuses once
 * an account exists, so a page that forgot to ask would show a form that
 * cannot be submitted rather than one that lets someone in.
 */

/** Several organizations share this installation; anyone may sign up. */
export function isMultiTenant(): boolean {
  return env.MULTI_TENANT
}

/**
 * Nobody has been through the setup screen yet.
 *
 * Deduplicated per request: the layouts that guard on it render above the
 * pages that do too.
 *
 * `connection()` is what keeps this out of `next build`. The answer comes from
 * the database, and the build has no database -- the image is built once and
 * run against whichever one it is pointed at. Every route that asks is already
 * dynamic because it reads the session, but a prerender pass runs the render
 * optimistically until it meets a request-time API, and this query would
 * otherwise run first and fail the build with ECONNREFUSED. Saying so here
 * rather than at each call site means the guard cannot be lost by reordering
 * two lines in a layout.
 */
export const needsSetup = cache(async (): Promise<boolean> => {
  // Before the connection check: multi-tenant installations never ask the
  // database, so there is nothing to keep out of the prerender.
  if (env.MULTI_TENANT) return false
  await connection()
  return !(await isInstalled())
})
