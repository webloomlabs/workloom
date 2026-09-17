import 'server-only'
import { isInstalled } from '@workloom/auth'
import { env } from '@workloom/config'
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
 */
export const needsSetup = cache(async (): Promise<boolean> => {
  if (env.MULTI_TENANT) return false
  return !(await isInstalled())
})
