import { handleMcp } from '@/lib/mcp/handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The MCP endpoint, for AI assistants such as ChatGPT and Claude.
 * See docs/mcp.md for how to connect one.
 */
const handler = (request: Request) => handleMcp(request)

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS }
