import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/** Drives Better Auth's sign-up, which a single-tenant installation closes. */
process.env.MULTI_TENANT = 'true'

/**
 * The MCP endpoint, end to end over a real database.
 *
 * What matters: an assistant authenticates only with a bearer credential,
 * sees only the tools its person and key allow, runs them through the same
 * procedure path as everything else, and leaves an audit trail marked as
 * coming from an AI assistant.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('@workloom/core')
let handleMcp: typeof import('../lib/mcp/handler.ts').handleMcp

let organizationId: string
let fullKey: string
let narrowKey: string
let authMod: typeof import('@workloom/auth')
let owner: { id: string; name: string; email: string }

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  authMod = await import('@workloom/auth')
  core = await import('@workloom/core')
  handleMcp = (await import('../lib/mcp/handler.ts')).handleMcp

  const signUp = await authMod.auth.api.signUpEmail({
    body: { email: 'owner@example.com', password: 'a-sufficiently-long-password', name: 'Olive' },
  })
  const userId = signUp.user.id
  owner = { id: userId, name: signUp.user.name, email: signUp.user.email }

  organizationId = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`insert into organization (id, name, slug) values (${organizationId}::uuid, 'Acme', 'acme')`)
    await db.execute(sql`
      insert into member (id, organization_id, user_id, role)
      values (${core.newId()}::uuid, ${organizationId}::uuid, ${userId}::uuid, 'owner')
    `)
  })

  async function issue(scopes: string[] | null) {
    const generated = core.generateApiKey()
    await mod.withTenant(organizationId, async (tx) => {
      await tx.insert(mod.schema.apiKeys).values({
        id: core.newId(),
        organizationId,
        userId,
        name: 'assistant',
        keyHash: generated.hash,
        keyPrefix: generated.displayPrefix,
        scopes,
      })
    })
    return generated.secret
  }

  fullKey = await issue(null)
  narrowKey = await issue(['company:read'])
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

let nextId = 1
function rpc(method: string, params: unknown, init: { key?: string | undefined; headers?: Record<string, string> } = {}) {
  return handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
        ...init.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    }),
  )
}

async function result(response: Response): Promise<any> {
  expect(response.status).toBe(200)
  const body = (await response.json()) as { result?: unknown; error?: unknown }
  expect(body.error).toBeUndefined()
  return body.result
}

async function callTool(key: string, name: string, args: Record<string, unknown> = {}) {
  return result(await rpc('tools/call', { name, arguments: args }, { key }))
}

describe('authentication', () => {
  it('refuses a request without a bearer credential, and says how to authenticate', async () => {
    const response = await rpc('tools/list', {})
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer /)
    // How ChatGPT and Claude find out where to send the person to connect.
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/api/mcp"')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('never accepts a session cookie, since the endpoint is open to any origin', async () => {
    const response = await rpc('tools/list', {}, { headers: { cookie: 'better-auth.session_token=anything' } })
    expect(response.status).toBe(401)
  })

  it('refuses an unknown key', async () => {
    const response = await rpc('tools/list', {}, { key: 'wl_live_not-a-real-key' })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('invalid_token')
  })

  it('answers a CORS preflight', async () => {
    const response = await handleMcp(new Request('http://localhost/api/mcp', { method: 'OPTIONS' }))
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization')
  })

  it('has no stream to open: GET is not allowed', async () => {
    const response = await handleMcp(
      new Request('http://localhost/api/mcp', { method: 'GET', headers: { authorization: `Bearer ${fullKey}` } }),
    )
    expect(response.status).toBe(405)
  })
})

describe('the protocol', () => {
  it('completes the initialize handshake', async () => {
    const init = await result(
      await rpc(
        'initialize',
        { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        { key: fullKey },
      ),
    )
    expect(init.serverInfo.name).toBe('workloom')
    expect(init.capabilities.tools).toBeDefined()
    expect(init.instructions).toContain('me_get')
  })

  it('lists only the tools the key allows', async () => {
    const full = (await result(await rpc('tools/list', {}, { key: fullKey }))).tools as Array<{ name: string }>
    const narrow = (await result(await rpc('tools/list', {}, { key: narrowKey }))).tools as Array<{ name: string }>

    const fullNames = full.map((t) => t.name)
    const narrowNames = narrow.map((t) => t.name)
    expect(fullNames).toContain('company_create')
    expect(fullNames).not.toContain('apiKey_create')
    expect(narrowNames).toContain('company_list')
    expect(narrowNames).toContain('me_get')
    expect(narrowNames).not.toContain('company_create')
  })

  it('reports who the assistant is acting as', async () => {
    const me = await callTool(fullKey, 'me_get')
    expect(me.isError).toBeUndefined()
    expect(me.structuredContent).toBeDefined()
    expect(JSON.parse(me.content[0].text)).toEqual(me.structuredContent)
  })

  it('runs a mutation through the procedure path and audits it as MCP', async () => {
    const created = await callTool(fullKey, 'company_create', { name: 'Globex' })
    expect(created.isError).toBeUndefined()
    const companyId = created.structuredContent.id as string

    const [entry] = await mod.withTenant(organizationId, (tx) =>
      tx.execute(sql`select source from audit_logs where entity_id = ${companyId}::uuid limit 1`),
    ).then((r: any) => r.rows ?? r)
    expect(entry.source).toBe('mcp')
  })

  it('returns validation details so the model can correct itself', async () => {
    const response = await callTool(fullKey, 'company_create', {})
    expect(response.isError).toBe(true)
    const error = JSON.parse(response.content[0].text)
    expect(error.code).toBe('invalid_request')
    expect(error.details[0].path).toBe('name')
  })

  it('treats a tool outside the key as unknown, not forbidden', async () => {
    const response = await callTool(narrowKey, 'company_create', { name: 'Nope' })
    expect(response.isError).toBe(true)
    expect(response.content[0].text).toBe('Unknown tool: company_create')
  })

  it('does not offer withheld procedures even to a full key', async () => {
    const response = await callTool(fullKey, 'apiKey_create', { name: 'x', scopes: null })
    expect(response.isError).toBe(true)
    expect(response.content[0].text).toBe('Unknown tool: apiKey_create')
  })
})

describe('connected through OAuth', () => {
  it('accepts a token from a person\'s consent, limited to what they chose', async () => {
    const { createHash, randomBytes } = await import('node:crypto')
    const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect'
    const client = await authMod.oauth.registerClient({ client_name: 'ChatGPT', redirect_uris: [redirect] })
    const verifier = randomBytes(32).toString('base64url')
    const validation = await authMod.oauth.validateAuthorizeRequest({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirect,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })
    if (!validation.ok) throw new Error('authorize failed')
    const back = new URL(
      await authMod.oauth.approveAuthorization({ request: validation.request, user: owner, organizationId, scopes: ['company:read'] }),
    )
    const tokens = await authMod.oauth.exchangeToken(
      { grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect },
      null,
    )

    const tools = (await result(await rpc('tools/list', {}, { key: tokens.access_token }))).tools as Array<{ name: string }>
    const names = tools.map((t) => t.name)
    expect(names).toContain('company_list')
    expect(names).not.toContain('company_create')

    const me = await callTool(tokens.access_token, 'me_get')
    expect(me.isError).toBeUndefined()
  })
})
