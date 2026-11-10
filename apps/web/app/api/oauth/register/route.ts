import { oauth } from '@workloom/auth'
import { json, limited, oauthError, preflight } from '@/lib/oauth/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** RFC 7591 Dynamic Client Registration. */
export async function POST(request: Request) {
  const slow = await limited(request, 'register', 'auth')
  if (slow) return slow
  try {
    const body: unknown = await request.json().catch(() => null)
    return json(await oauth.registerClient(body), 201)
  } catch (error) {
    return oauthError(error)
  }
}

export function OPTIONS() {
  return preflight()
}
