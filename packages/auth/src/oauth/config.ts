import { env } from '@workloom/config'

/**
 * The fixed points of Workloom's OAuth 2.1 server.
 *
 * Every URL derives from APP_URL, never from a request's Host header: the
 * issuer and resource are identities that clients compare character for
 * character, and a Host header is whatever the caller says it is.
 */

export const ACCESS_TOKEN_PREFIX = 'wl_oat_'
export const REFRESH_TOKEN_PREFIX = 'wl_ort_'
export const CLIENT_ID_PREFIX = 'wlc_'
export const CLIENT_SECRET_PREFIX = 'wl_ocs_'

export const ACCESS_TOKEN_SECONDS = 60 * 60
export const REFRESH_TOKEN_SECONDS = 60 * 24 * 60 * 60
export const CODE_SECONDS = 5 * 60
/**
 * A client that refreshes twice at once presents the same refresh token
 * twice. Within this window the second attempt is served rather than taken
 * for theft.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 30

/** The single scope advertised. What a grant may do is chosen at consent, as permissions. */
export const OAUTH_SCOPE = 'workloom'

export function issuer(): string {
  return env.APP_URL.replace(/\/+$/, '')
}

/** The protected resource (RFC 8707/9728): the MCP endpoint. */
export function mcpResource(): string {
  return `${issuer()}/api/mcp`
}

export function normalizeResource(value: string): string {
  return value.replace(/\/+$/, '')
}
