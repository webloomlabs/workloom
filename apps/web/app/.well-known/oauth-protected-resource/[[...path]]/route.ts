import { oauth } from '@workloom/auth'
import { metadata, preflight } from '@/lib/oauth/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * RFC 9728 protected resource metadata, for the MCP endpoint. Served at the
 * bare path and at `/api/mcp` appended, since clients look in both places.
 */
export function GET() {
  return metadata(oauth.protectedResourceMetadata())
}

export function OPTIONS() {
  return preflight()
}
