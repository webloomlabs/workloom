import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/** Drives Better Auth's sign-up, which a single-tenant installation closes. */
process.env.MULTI_TENANT = 'true'

/**
 * The OAuth server that lets ChatGPT and Claude connect to the MCP endpoint.
 *
 * The claims: a token comes only from a person's consent, carried by a code
 * that works once, for the client it was issued to, with the right PKCE
 * verifier; it never does more than that person may do right now; it works
 * only at the MCP endpoint; and a leaked refresh token ends the connection.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let authMod: typeof import('../src/index.ts')
let core: typeof import('@workloom/core')

let organizationId: string
let user: { id: string; name: string; email: string }

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  authMod = await import('../src/index.ts')
  core = await import('@workloom/core')

  const signUp = await authMod.auth.api.signUpEmail({
    body: { email: 'ada@example.com', password: 'a-sufficiently-long-password', name: 'Ada' },
  })
  user = { id: signUp.user.id, name: signUp.user.name, email: signUp.user.email }

  organizationId = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`insert into organization (id, name, slug) values (${organizationId}::uuid, 'Acme', 'acme')`)
    await db.execute(sql`
      insert into member (id, organization_id, user_id, role)
      values (${core.newId()}::uuid, ${organizationId}::uuid, ${user.id}::uuid, 'finance')
    `)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

const oauth = () => authMod.oauth
const resource = () => `${process.env.APP_URL!.replace(/\/+$/, '')}/api/mcp`

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function setRole(role: string | null) {
  await mod.withoutTenant('test: change role', async (db) => {
    if (role === null) {
      await db.execute(sql`delete from member where organization_id = ${organizationId}::uuid and user_id = ${user.id}::uuid`)
    } else {
      await db.execute(sql`
        insert into member (id, organization_id, user_id, role)
        values (${core.newId()}::uuid, ${organizationId}::uuid, ${user.id}::uuid, ${role})
        on conflict do nothing
      `)
      await db.execute(sql`
        update member set role = ${role}
        where organization_id = ${organizationId}::uuid and user_id = ${user.id}::uuid
      `)
    }
  })
}

async function register(redirectUris = [REDIRECT]) {
  return oauth().registerClient({ client_name: 'Claude', redirect_uris: redirectUris })
}

/** Register, consent, and come back with a code -- what claude.ai does when someone clicks Connect. */
async function authorize(scopes: string[] | null = null) {
  const client = await register()
  const { verifier, challenge } = pkce()
  const validation = await oauth().validateAuthorizeRequest({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: resource(),
  })
  if (!validation.ok) throw new Error(`authorize failed: ${JSON.stringify(validation)}`)
  const redirectTo = await oauth().approveAuthorization({ request: validation.request, user, organizationId, scopes })
  const url = new URL(redirectTo)
  return { client, verifier, url, code: url.searchParams.get('code')! }
}

async function connect(scopes: string[] | null = null) {
  const { client, verifier, code } = await authorize(scopes)
  const tokens = await oauth().exchangeToken(
    { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: resource() },
    null,
  )
  return { client, tokens }
}

function bearer(token: string) {
  return new Headers({ authorization: `Bearer ${token}` })
}

describe('discovery', () => {
  it('points the MCP endpoint at this server, with PKCE and registration advertised', () => {
    const resourceMeta = oauth().protectedResourceMetadata()
    expect(resourceMeta.resource).toBe(resource())
    expect(resourceMeta.authorization_servers).toEqual([oauth().issuer()])

    const server = oauth().authorizationServerMetadata()
    expect(server.code_challenge_methods_supported).toEqual(['S256'])
    expect(server.registration_endpoint).toMatch(/\/api\/oauth\/register$/)
  })
})

describe('client registration', () => {
  it('registers a public client', async () => {
    const client = await register()
    expect(client.client_id).toMatch(/^wlc_/)
    expect(client.token_endpoint_auth_method).toBe('none')
    expect(client).not.toHaveProperty('client_secret')
  })

  it.each([
    'javascript:alert(1)',
    'http://evil.example.com/callback',
    'https://app.example.com/callback#fragment',
    'data:text/html,hi',
  ])('refuses the redirect URI %s', async (uri) => {
    await expect(register([uri])).rejects.toMatchObject({ error: 'invalid_redirect_uri' })
  })

  it('accepts loopback http and https', async () => {
    await expect(register(['http://127.0.0.1:33418/callback', 'https://chatgpt.com/connector_platform_oauth_redirect'])).resolves.toBeTruthy()
  })
})

describe('the authorization request', () => {
  it('shows an error, and redirects nowhere, for an unknown client or redirect', async () => {
    const unknown = await oauth().validateAuthorizeRequest({ client_id: 'wlc_nope', redirect_uri: REDIRECT })
    expect(unknown).toMatchObject({ ok: false, kind: 'show' })

    const client = await register()
    const elsewhere = await oauth().validateAuthorizeRequest({ client_id: client.client_id, redirect_uri: 'https://evil.example.com/cb' })
    expect(elsewhere).toMatchObject({ ok: false, kind: 'show' })
  })

  it('requires PKCE, and a resource that is this MCP endpoint', async () => {
    const client = await register()
    const base = { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's' }

    const noPkce = await oauth().validateAuthorizeRequest(base)
    expect(noPkce).toMatchObject({ ok: false, kind: 'redirect' })
    if (!noPkce.ok && noPkce.kind === 'redirect') {
      const url = new URL(noPkce.redirectTo)
      expect(url.searchParams.get('error')).toBe('invalid_request')
      expect(url.searchParams.get('state')).toBe('s')
    }

    const wrongResource = await oauth().validateAuthorizeRequest({
      ...base,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: 'https://other.example.com/mcp',
    })
    expect(wrongResource).toMatchObject({ ok: false, kind: 'redirect' })
  })

  it('returns the code with state and issuer, and records the consent', async () => {
    const { url } = await authorize()
    expect(url.origin + url.pathname).toBe(REDIRECT)
    expect(url.searchParams.get('state')).toBe('xyz')
    expect(url.searchParams.get('iss')).toBe(oauth().issuer())

    const { rows } = await mod.withTenant(organizationId, (tx) =>
      tx.execute<{ count: string }>(sql`select count(*)::text as count from audit_logs where action = 'oauth_grant.created'`),
    )
    expect(Number(rows[0]!.count)).toBeGreaterThan(0)
  })

  it('caps the scopes at the person\'s role', async () => {
    // A finance person cannot hand an app permission to remove members.
    await expect(authorize(['member:remove'])).rejects.toMatchObject({ code: 'scopes_empty' })
  })
})

describe('the token endpoint', () => {
  it('exchanges a code once, and only with the right verifier, client, and redirect', async () => {
    const { client, verifier, code } = await authorize()
    const exchange = (overrides: Record<string, string>) =>
      oauth().exchangeToken(
        { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, ...overrides },
        null,
      )

    // A wrong verifier spends the code: it is consumed before it is checked.
    await expect(exchange({ code_verifier: pkce().verifier })).rejects.toMatchObject({ error: 'invalid_grant' })
    await expect(exchange({})).rejects.toMatchObject({ error: 'invalid_grant' })

    const second = await authorize()
    const other = await register()
    await expect(
      oauth().exchangeToken(
        { grant_type: 'authorization_code', code: second.code, code_verifier: second.verifier, client_id: other.client_id, redirect_uri: REDIRECT },
        null,
      ),
    ).rejects.toMatchObject({ error: 'invalid_grant' })

    const third = await authorize()
    await expect(
      oauth().exchangeToken(
        { grant_type: 'authorization_code', code: third.code, code_verifier: third.verifier, client_id: third.client.client_id, redirect_uri: 'https://claude.ai/other' },
        null,
      ),
    ).rejects.toMatchObject({ error: 'invalid_grant' })

    const fourth = await authorize()
    const tokens = await oauth().exchangeToken(
      { grant_type: 'authorization_code', code: fourth.code, code_verifier: fourth.verifier, client_id: fourth.client.client_id, redirect_uri: REDIRECT },
      null,
    )
    expect(tokens.access_token).toMatch(/^wl_oat_/)
    expect(tokens.refresh_token).toMatch(/^wl_ort_/)
    expect(Object.keys(tokens).sort()).toEqual(['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type'])
    await expect(
      oauth().exchangeToken(
        { grant_type: 'authorization_code', code: fourth.code, code_verifier: fourth.verifier, client_id: fourth.client.client_id, redirect_uri: REDIRECT },
        null,
      ),
    ).rejects.toMatchObject({ error: 'invalid_grant' })
  })
})

describe('using a token', () => {
  it('acts as the person, narrowed by the chosen scopes, at the MCP endpoint only', async () => {
    const { tokens } = await connect(['invoice:read'])

    const atMcp = await authMod.resolveActor({ headers: bearer(tokens.access_token), audience: 'mcp' })
    expect(atMcp.ok).toBe(true)
    if (!atMcp.ok) return
    expect(atMcp.organizationId).toBe(organizationId)
    expect([...atMcp.permissions]).toEqual(['invoice:read'])
    expect(atMcp.actor).toMatchObject({ type: 'apiKey', userId: user.id, credential: 'oauth', label: 'Claude (Ada)' })

    const atRest = await authMod.resolveActor({ headers: bearer(tokens.access_token) })
    expect(atRest).toEqual({ ok: false, reason: 'invalid-key' })
  })

  it('follows the person\'s current role, and stops when they leave', async () => {
    const { tokens } = await connect(null)
    const before = await authMod.resolveActor({ headers: bearer(tokens.access_token), audience: 'mcp' })
    expect(before.ok && before.permissions.has('invoice:create')).toBe(true)

    await setRole('developer')
    const demoted = await authMod.resolveActor({ headers: bearer(tokens.access_token), audience: 'mcp' })
    expect(demoted.ok && demoted.permissions.has('invoice:create')).toBe(false)

    await setRole(null)
    const gone = await authMod.resolveActor({ headers: bearer(tokens.access_token), audience: 'mcp' })
    expect(gone).toEqual({ ok: false, reason: 'not-a-member' })

    await setRole('finance')
  })
})

describe('refreshing', () => {
  it('rotates the refresh token, and treats a late reuse as theft', async () => {
    const { client, tokens } = await connect()
    const t0 = new Date()
    const refreshed = await oauth().exchangeToken(
      { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id },
      null,
      t0,
    )
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)

    // Seconds later: a client refreshing twice at once. Served.
    await expect(
      oauth().exchangeToken(
        { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id },
        null,
        new Date(t0.getTime() + 5_000),
      ),
    ).resolves.toBeTruthy()

    // Minutes later: the old token has leaked. The whole connection ends.
    await expect(
      oauth().exchangeToken(
        { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id },
        null,
        new Date(t0.getTime() + 5 * 60_000),
      ),
    ).rejects.toMatchObject({ error: 'invalid_grant' })

    const after = await authMod.resolveActor({ headers: bearer(refreshed.access_token), audience: 'mcp' })
    expect(after).toEqual({ ok: false, reason: 'invalid-key' })
  })

  it('refuses another client\'s refresh token', async () => {
    const { tokens } = await connect()
    const other = await register()
    await expect(
      oauth().exchangeToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: other.client_id }, null),
    ).rejects.toMatchObject({ error: 'invalid_grant' })
  })
})

describe('revoking', () => {
  it('ends the connection when the app asks', async () => {
    const { client, tokens } = await connect()
    await oauth().revokeToken({ token: tokens.refresh_token, client_id: client.client_id }, null)
    const after = await authMod.resolveActor({ headers: bearer(tokens.access_token), audience: 'mcp' })
    expect(after).toEqual({ ok: false, reason: 'invalid-key' })
  })

  it('replaces an earlier connection when the same person connects the same app again', async () => {
    const { client, verifier, code } = await authorize()
    const first = await oauth().exchangeToken(
      { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT },
      null,
    )
    const { challenge, verifier: v2 } = pkce()
    const validation = await oauth().validateAuthorizeRequest({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    if (!validation.ok) throw new Error('authorize failed')
    const again = new URL(await oauth().approveAuthorization({ request: validation.request, user, organizationId, scopes: null }))
    await oauth().exchangeToken(
      { grant_type: 'authorization_code', code: again.searchParams.get('code')!, code_verifier: v2, client_id: client.client_id, redirect_uri: REDIRECT },
      null,
    )

    const old = await authMod.resolveActor({ headers: bearer(first.access_token), audience: 'mcp' })
    expect(old).toEqual({ ok: false, reason: 'invalid-key' })
  })
})
