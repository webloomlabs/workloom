import { oauth } from '@workloom/auth'
import { json, limited, oauthError, preflight, readParams } from '@/lib/oauth/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** RFC 7009 token revocation. Answers 200 whether or not the token existed. */
export async function POST(request: Request) {
  const slow = await limited(request, 'revoke', 'authIp')
  if (slow) return slow
  try {
    await oauth.revokeToken(await readParams(request), request.headers.get('authorization'))
    return json({})
  } catch (error) {
    return oauthError(error)
  }
}

export function OPTIONS() {
  return preflight()
}
