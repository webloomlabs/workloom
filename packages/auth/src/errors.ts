import { APIError } from 'better-auth/api'

/**
 * Recognises an error raised by Better Auth and extracts its user-facing
 * message ("Invalid email or password", "User already exists").
 *
 * Exposed so that transports can show these messages without depending on
 * `better-auth` themselves -- which library provides authentication is this
 * package's business alone.
 */
export function authErrorMessage(error: unknown): string | null {
  if (!(error instanceof APIError)) return null
  const body = error.body as { message?: unknown } | undefined
  return typeof body?.message === 'string' ? body.message : error.message || null
}

/**
 * Better Auth's machine-readable error code, e.g.
 * `EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION`. Pages that branch on why an
 * operation was refused use this rather than matching message text.
 */
export function authErrorCode(error: unknown): string | null {
  if (!(error instanceof APIError)) return null
  const body = error.body as { code?: unknown } | undefined
  return typeof body?.code === 'string' ? body.code : null
}
