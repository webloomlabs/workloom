import { oauth } from '@workloom/auth'
import { metadata, preflight } from '@/lib/oauth/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * RFC 8414 authorization server metadata. Also answers with a path appended,
 * which some MCP clients try first.
 */
export function GET() {
  return metadata(oauth.authorizationServerMetadata())
}

export function OPTIONS() {
  return preflight()
}
