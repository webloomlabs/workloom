import { oauth } from '@workloom/auth'
import { json, limited, oauthError, preflight, readParams } from '@/lib/oauth/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The token endpoint: authorization codes and refresh tokens in, tokens out. */
export async function POST(request: Request) {
  const slow = await limited(request, 'token', 'authIp')
  if (slow) return slow
  try {
    const params = await readParams(request)
    return json(await oauth.exchangeToken(params, request.headers.get('authorization')))
  } catch (error) {
    return oauthError(error)
  }
}

export function OPTIONS() {
  return preflight()
}
