import { consumeRateLimit, type AuthRateLimitClass } from '@workloom/core'
import { APIError, createAuthMiddleware, getIP } from 'better-auth/api'

/**
 * Rate limits for the unauthenticated authentication endpoints.
 *
 * Runs as a Better Auth `before` hook, which Better Auth applies both to
 * requests through `/api/auth/*` and to in-process `auth.api.*` calls -- the
 * path every Server Action takes. Better Auth's own limiter covers only the
 * first, keeps its counts in one process's memory, and is off outside
 * production; this one is shared through Postgres and always on.
 *
 * Each endpoint is limited per email address (the control an attacker cannot
 * sidestep by changing IP) and per IP (to slow spraying one password across
 * many addresses).
 */
const LIMITED: Record<string, { email?: AuthRateLimitClass }> = {
  '/sign-in/email': { email: 'auth' },
  '/sign-up/email': { email: 'auth' },
  '/request-password-reset': { email: 'authMail' },
  '/send-verification-email': { email: 'authMail' },
  '/reset-password': {},
}

const TOO_MANY = 'Too many attempts. Wait a minute and try again.'

export const authRateLimit = createAuthMiddleware(async (ctx) => {
  const rule = LIMITED[ctx.path]
  if (!rule) return

  const checks: Array<Promise<{ allowed: boolean }>> = []

  const email = (ctx.body as { email?: unknown } | undefined)?.email
  if (rule.email && typeof email === 'string' && email.trim()) {
    const normalized = email.trim().toLowerCase()
    checks.push(consumeRateLimit(`auth:${rule.email}:${ctx.path}:${normalized}`, rule.email))
  }

  const source = ctx.request ?? ctx.headers
  const ip = source ? getIP(source, ctx.context.options) : null
  if (ip) checks.push(consumeRateLimit(`auth:authIp:${ip}`, 'authIp'))

  const decisions = await Promise.all(checks)
  if (decisions.some((d) => !d.allowed)) {
    throw new APIError('TOO_MANY_REQUESTS', { message: TOO_MANY })
  }
})
