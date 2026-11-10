import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { resolveActor } from '@workloom/auth'
import { consumeRateLimit, newId, rateLimitKey } from '@workloom/core'
import { executeProcedure, getProcedure, isPermitted, mcpToolByName, mcpToolsFor, type RateLimitClass } from '@workloom/core/registry'
import '@workloom/core/modules'
import { env } from '@workloom/config'
import { toApiError } from '../api/errors.ts'

/**
 * The MCP server: Workloom as a connector for ChatGPT, Claude, and any other
 * MCP client.
 *
 * Like the REST API, this layer holds no business logic. It identifies the
 * caller, applies the same rate limits, and turns `tools/call` into
 * `executeProcedure` -- so an assistant can do exactly what its person can
 * do, through the same permission checks and audit trail, and nothing more.
 * The tools themselves are generated from the registry (`mcpTools`).
 *
 * Stateless Streamable HTTP with JSON responses: each POST is answered in
 * full and nothing is held between requests, which suits a plain Next route
 * and any number of server instances.
 */

export const MCP_PATH = '/api/mcp'

/**
 * Open to any origin, deliberately. This endpoint accepts a bearer token and
 * nothing else -- never the session cookie -- so a cross-origin page gains
 * nothing it could not already do with the token it would need to hold.
 */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '86400',
}

const INSTRUCTIONS = [
  'Workloom runs a digital agency: leads, clients, quotes, projects, tasks, time, invoices, expenses, banking, and books.',
  'Call me_get first to learn who you are acting as, which organization, and which permissions you hold.',
  'Records are referred to by UUID; use the *_list tools (most accept a `q` search) to find the id you need.',
  'Money amounts are integers in minor units (amountMinor: 1050 means 10.50 in the record currency).',
  'Everything you do is recorded in the audit log under the person who connected you.',
  'Never send or email anything to a client, delete records, or change money records unless the person asked for exactly that.',
].join(' ')

/** Large enough for any sensible page of results, small enough not to swamp the model's context. */
const MAX_RESULT_CHARS = 300_000

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  // Bearer only. Falling back to the session cookie would make this endpoint
  // a cross-site request target for anyone signed in.
  if (!request.headers.get('authorization')?.startsWith('Bearer ')) return unauthorized()

  // Stateless: there is no server-to-client stream to open (GET) and no
  // session to end (DELETE).
  if (request.method !== 'POST') {
    return withCors(
      Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { status: 405, headers: { Allow: 'POST, OPTIONS' } }),
    )
  }

  // OAuth access tokens are accepted here and nowhere else (RFC 8707).
  const caller = await resolveActor({ headers: request.headers, audience: 'mcp' })
  // 401 even for a former member, so the client re-authenticates rather than
  // concluding the server is gone.
  if (!caller.ok) return unauthorized('invalid_token')

  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined
  const userAgent = request.headers.get('user-agent') ?? undefined
  const actorId = 'id' in caller.actor ? caller.actor.id : caller.actor.type
  const limit = (klass: RateLimitClass) =>
    consumeRateLimit(rateLimitKey({ organizationId: caller.organizationId, actorId, klass }), klass)

  const server = new Server(
    { name: 'workloom', title: 'Workloom', version: '1.0.0', websiteUrl: env.APP_URL },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await limit('read')
    return {
      tools: mcpToolsFor(caller.permissions).map(({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        annotations,
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
    const tool = mcpToolByName(params.name)
    // An unpermitted tool is reported exactly like a missing one: it was never listed.
    const procedure = tool && isPermitted(tool, caller.permissions) ? getProcedure(tool.procedure) : undefined
    if (!tool || !procedure) return toolError(`Unknown tool: ${params.name}`)

    const decision = await limit(procedure.rateLimit ?? (procedure.readOnly ? 'read' : 'write'))
    if (!decision.allowed) return toolError(`Rate limited. Retry in ${decision.resetSeconds}s.`)

    const requestId = newId()
    try {
      const output = await executeProcedure(procedure.name, {
        organizationId: caller.organizationId,
        actor: caller.actor,
        role: caller.role as never,
        permissions: caller.permissions,
        input: params.arguments ?? {},
        requestId,
        ipAddress,
        userAgent,
        source: 'mcp',
      })
      return toolResult(output)
    } catch (error) {
      // The same envelope as the REST API. Validation details let the model
      // correct its own arguments and try again.
      const { body } = toApiError(error, requestId)
      return toolError(JSON.stringify(body.error))
    }
  })

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }) // no sessionIdGenerator: stateless
  await server.connect(transport)
  try {
    // With JSON responses the body is complete when this resolves, so
    // closing the server afterwards cannot cut a reply short.
    return withCors(await transport.handleRequest(request))
  } finally {
    await server.close()
  }
}

function toolResult(output: unknown): CallToolResult {
  // Dates become ISO strings, exactly as they do in the REST API.
  const text = JSON.stringify(output ?? null)
  if (text.length > MAX_RESULT_CHARS) {
    return toolError('The result is too large to return. Narrow it with filters or a smaller `limit`, and page with `cursor`.')
  }
  const json: unknown = JSON.parse(text)
  return {
    content: [{ type: 'text', text }],
    ...(json && typeof json === 'object' && !Array.isArray(json) ? { structuredContent: json as Record<string, unknown> } : {}),
  }
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/**
 * Points the client at the OAuth metadata (RFC 9728), which is how ChatGPT
 * and Claude discover where to send the person to connect.
 */
function unauthorized(error?: 'invalid_token'): Response {
  const params = [
    'realm="workloom"',
    `resource_metadata="${env.APP_URL.replace(/\/+$/, '')}/.well-known/oauth-protected-resource${MCP_PATH}"`,
    ...(error ? [`error="${error}"`] : []),
  ]
  return new Response(JSON.stringify({ error: 'unauthorized', message: 'Send `Authorization: Bearer <API key or access token>`.' }), {
    status: 401,
    headers: { ...CORS, 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer ${params.join(', ')}` },
  })
}

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value)
  return response
}
