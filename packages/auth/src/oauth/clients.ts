import { randomBytes } from 'node:crypto'
import { generateSecret, hashApiKey } from '@workloom/core'
// oauth_clients has no organization and is not under RLS, like rate_limits.
import { db, eq, schema } from '@workloom/db'
import { z } from 'zod'
import { CLIENT_ID_PREFIX, CLIENT_SECRET_PREFIX } from './config.ts'
import { OAuthError } from './errors.ts'

/**
 * Dynamic Client Registration (RFC 7591).
 *
 * Open to anyone, as the MCP authorization spec expects: ChatGPT and Claude
 * register themselves the first time someone adds Workloom as a connector.
 * Registering grants nothing -- a client can only ever obtain a token
 * through a person's explicit consent -- so what matters is that a
 * registration cannot be used to send that person, or their code, anywhere
 * unexpected. That is the redirect URI rules below, and the consent screen
 * showing where the person will be returned.
 */

export type OAuthClient = typeof schema.oauthClients.$inferSelect

const MAX_REDIRECT_URIS = 10

const registration = z.object({
  redirect_uris: z.array(z.string().min(1).max(2000)).min(1).max(MAX_REDIRECT_URIS),
  client_name: z.string().trim().max(100).optional(),
  client_uri: z.url().max(2000).optional(),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
})

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * A redirect URI a client may register.
 *
 * - `https:` anywhere;
 * - `http:` only to this machine, for desktop and CLI clients (RFC 8252 §7.3);
 * - a private-use scheme with a dot in it, such as `cursor://` or
 *   `com.example.app:/` (RFC 8252 §7.1).
 *
 * Never `javascript:`, `data:`, `file:`, or anything with a fragment.
 */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.hash || value.includes('#')) return false
  if (url.protocol === 'https:') return url.hostname !== ''
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname)
  const scheme = url.protocol.slice(0, -1)
  if (['javascript', 'data', 'file', 'blob', 'about', 'vbscript', 'ws', 'wss', 'ftp'].includes(scheme)) return false
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+$/i.test(scheme) || ['cursor', 'vscode', 'vscode-insiders', 'windsurf', 'claude'].includes(scheme)
}

/**
 * Exact match, except that a loopback redirect may use any port: native
 * apps listen on whatever port is free when they start (RFC 8252 §7.3).
 */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true
  let target: URL
  try {
    target = new URL(presented)
  } catch {
    return false
  }
  if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) return false
  return registered.some((uri) => {
    try {
      const candidate = new URL(uri)
      return (
        candidate.protocol === 'http:' &&
        candidate.hostname === target.hostname &&
        candidate.pathname === target.pathname &&
        candidate.search === target.search
      )
    } catch {
      return false
    }
  })
}

export async function registerClient(body: unknown, now = new Date()) {
  const parsed = registration.safeParse(body)
  if (!parsed.success) {
    throw new OAuthError('invalid_client_metadata', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  }
  const input = parsed.data
  const rejected = input.redirect_uris.find((uri) => !isAllowedRedirectUri(uri))
  if (rejected !== undefined) {
    throw new OAuthError('invalid_redirect_uri', `Redirect URI not allowed: ${rejected}. Use https, or http on localhost.`)
  }
  if (input.grant_types?.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    throw new OAuthError('invalid_client_metadata', 'Only the authorization_code and refresh_token grant types are supported.')
  }
  if (input.response_types?.some((r) => r !== 'code')) {
    throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported.')
  }

  const method = input.token_endpoint_auth_method ?? 'none'
  const secret = method === 'none' ? undefined : generateSecret(CLIENT_SECRET_PREFIX)
  const id = CLIENT_ID_PREFIX + randomBytes(16).toString('base64url')
  const name = input.client_name || 'Unnamed app'

  await db.insert(schema.oauthClients).values({
    id,
    clientName: name,
    clientUri: input.client_uri ?? null,
    redirectUris: input.redirect_uris,
    tokenEndpointAuthMethod: method,
    clientSecretHash: secret?.hash ?? null,
    createdAt: now,
  })

  return {
    client_id: id,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: name,
    ...(input.client_uri ? { client_uri: input.client_uri } : {}),
    redirect_uris: input.redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    ...(secret ? { client_secret: secret.secret, client_secret_expires_at: 0 } : {}),
  }
}

export async function getClient(id: string): Promise<OAuthClient | undefined> {
  if (!id.startsWith(CLIENT_ID_PREFIX)) return undefined
  const [client] = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, id)).limit(1)
  return client
}

/**
 * Checks a client's secret, where it has one. A public client (the usual
 * case: ChatGPT, Claude, desktop apps) proves itself with PKCE instead.
 */
export function authenticateClient(client: OAuthClient, presentedSecret: string | undefined): void {
  if (client.tokenEndpointAuthMethod === 'none') return
  if (!presentedSecret || !client.clientSecretHash || hashApiKey(presentedSecret) !== client.clientSecretHash) {
    throw new OAuthError('invalid_client', 'Client authentication failed.', 401)
  }
}

/** Client credentials from HTTP Basic, or from the body. */
export function clientCredentials(
  authorization: string | null,
  body: Record<string, string | undefined>,
): { clientId: string | undefined; clientSecret: string | undefined } {
  if (authorization?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authorization.slice('Basic '.length).trim(), 'base64').toString('utf8')
      const colon = decoded.indexOf(':')
      if (colon > 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, colon)),
          clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
        }
      }
    } catch {
      // Fall through to the body.
    }
  }
  return { clientId: body.client_id, clientSecret: body.client_secret }
}
