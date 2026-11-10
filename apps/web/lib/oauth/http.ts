import { oauth } from '@workloom/auth'
import { consumeRateLimit } from '@workloom/core'

/**
 * Plumbing shared by the OAuth endpoints. The protocol itself lives in
 * `@workloom/auth` (`oauth.*`); these routes only translate HTTP.
 *
 * Every endpoint here is open to any origin. None of them reads a cookie --
 * they act only on what the request carries -- so CORS grants a page
 * nothing it could not do from a server, and browser-based MCP clients need
 * it.
 */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '86400',
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS })
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, 'Cache-Control': 'no-store', Pragma: 'no-cache', ...headers } })
}

/** Discovery documents: public, and fine to cache for a while. */
export function metadata(body: unknown): Response {
  return Response.json(body, { headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' } })
}

/** Form-encoded, as the spec says, or JSON, as some clients send anyway. */
export async function readParams(request: Request): Promise<Record<string, string | undefined>> {
  const type = request.headers.get('content-type') ?? ''
  try {
    if (type.includes('application/json')) {
      const body = (await request.json()) as unknown
      if (!body || typeof body !== 'object') return {}
      return Object.fromEntries(
        Object.entries(body as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
          .map(([k, v]) => [k, String(v)]),
      )
    }
    return Object.fromEntries(new URLSearchParams(await request.text()))
  } catch {
    return {}
  }
}

export function oauthError(error: unknown): Response {
  if (error instanceof oauth.OAuthError) {
    return json(error.toJSON(), error.status, error.status === 401 ? { 'WWW-Authenticate': 'Basic realm="workloom"' } : {})
  }
  console.error('[oauth] unhandled error', error)
  return json({ error: 'server_error', error_description: 'Something went wrong.' }, 500)
}

/**
 * Per client IP. Trusts x-forwarded-for, which a direct caller can forge --
 * acceptable for a brake on runaway clients, not a security boundary. The
 * real controls are consent and PKCE.
 */
export async function limited(request: Request, bucket: string, klass: 'auth' | 'authIp'): Promise<Response | null> {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const decision = await consumeRateLimit(`oauth-${bucket}:ip:${ip}`, klass)
  if (decision.allowed) return null
  return json(
    { error: 'slow_down', error_description: `Too many requests. Retry in ${decision.resetSeconds}s.` },
    429,
    { 'Retry-After': String(decision.resetSeconds) },
  )
}
