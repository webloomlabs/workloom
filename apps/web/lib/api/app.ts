import { resolveActor } from '@workloom/auth'
import { consumeRateLimit, newId, rateLimitKey } from '@workloom/core'
import { exportFilename, isExportResource, toCsv, type ExportResource } from '@workloom/core/modules'
import { allProcedures, buildOpenApiDocument, executeProcedure, type AnyProcedure } from '@workloom/core/registry'
import '@workloom/core/modules'
import { env } from '@workloom/config'
import { Hono, type Context } from 'hono'
import { toApiError } from './errors.ts'

/**
 * The public REST API.
 *
 * Routes are generated from the procedure registry rather than written by
 * hand. That is what makes "every operation the UI can perform is also in the
 * API" a structural property instead of a promise -- there is no way to add a
 * feature to one and forget the other.
 *
 * This layer does five things and no more: identify the caller, apply rate
 * limits, translate HTTP into a procedure call, translate errors back, and
 * serve the OpenAPI document. It contains no business logic, and a lint rule
 * stops any from arriving. The one hand-written route, the CSV export, is a
 * second representation of a generated one and calls the same procedure.
 */
type ApiEnv = { Variables: { requestId: string } }

export function createApiApp() {
  const app = new Hono<ApiEnv>().basePath('/api/v1')

  app.get('/openapi.json', (c) => c.json(buildOpenApiDocument(`${env.APP_URL}/api/v1`)))

  mountCsvExport(app)

  for (const procedure of allProcedures()) {
    mount(app, procedure)
  }

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'not_found',
          message: 'No such endpoint. See /api/v1/openapi.json for what exists.',
          request_id: c.get('requestId') ?? 'unknown',
        },
      },
      404,
    ),
  )

  return app
}

/**
 * Who is calling, and may they call this much.
 *
 * Returns either a `Response` to send back untouched, or the resolved caller.
 * Extracted so that the one hand-written route is identified and limited by
 * exactly the same code as the generated ones -- an export that skipped the
 * rate limit would be the most expensive endpoint in the system and the only
 * unguarded one.
 */
type Authorized = Awaited<ReturnType<typeof resolveActor>> & { ok: true }

async function authorize(
  c: Context<ApiEnv, string>,
  options: { requestId: string; klass: 'read' | 'write' | 'expensive' | 'auth'; write: boolean },
): Promise<{ response: Response } | { caller: Authorized }> {
  const { requestId, klass } = options
  const headers = c.req.raw.headers

  /**
   * Cross-site request forgery.
   *
   * The API accepts the browser's session cookie as well as API keys. For a
   * cookie-authenticated write, require the request to come from this
   * application's own origin. SameSite=Lax cookies already stop the classic
   * cross-site form post; this makes the guarantee explicit rather than
   * dependent on a cookie attribute and browser behaviour. API-key requests
   * carry no ambient credential, so they are exempt.
   */
  const usesCookie = !headers.get('authorization')?.startsWith('Bearer ')
  if (usesCookie && options.write) {
    const origin = headers.get('origin')
    if (!origin || origin !== new URL(env.APP_URL).origin) {
      return {
        response: c.json(
          {
            error: {
              code: 'cross_origin_forbidden',
              message: 'Cookie-authenticated writes must come from this application. Use an API key for programmatic access.',
              request_id: requestId,
            },
          },
          403,
        ),
      }
    }
  }

  const resolution = await resolveActor({ headers })
  if (!resolution.ok) {
    return {
      response: c.json(
        {
          error: {
            code: resolution.reason === 'not-a-member' ? 'not_found' : 'unauthorized',
            message: unauthorizedMessage(resolution.reason),
            request_id: requestId,
          },
        },
        // A caller who is authenticated but not a member of the organization
        // gets 404, not 403 -- 403 would confirm the organization exists.
        resolution.reason === 'not-a-member' ? 404 : 401,
      ),
    }
  }

  const limit = await consumeRateLimit(
    rateLimitKey({ organizationId: resolution.organizationId, actorId: actorKey(resolution.actor), klass }),
    klass,
  )

  c.header('X-RateLimit-Limit', String(limit.limit))
  c.header('X-RateLimit-Remaining', String(limit.remaining))
  c.header('X-RateLimit-Reset', String(limit.resetSeconds))
  c.header('X-Request-Id', requestId)

  if (!limit.allowed) {
    c.header('Retry-After', String(limit.resetSeconds))
    return {
      response: c.json(
        {
          error: {
            code: 'rate_limited',
            message: `Too many ${klass} requests. Retry in ${limit.resetSeconds}s.`,
            request_id: requestId,
          },
        },
        429,
      ),
    }
  }

  return { caller: resolution as Authorized }
}

/**
 * The same export as `GET /exports/{resource}`, as a spreadsheet.
 *
 * Registered before the generated routes so the `.csv` suffix wins, and it
 * calls the very same procedure -- so the two representations cannot disagree
 * about what is in an export or who may have it.
 */
function mountCsvExport(app: Hono<ApiEnv>) {
  app.get('/exports/:file{[a-z-]+\\.csv}', async (c) => {
    const requestId = newId()
    c.set('requestId', requestId)
    const resource = c.req.param('file').replace(/\.csv$/, '')
    if (!isExportResource(resource)) return c.notFound()

    try {
      const guard = await authorize(c, { requestId, klass: 'expensive', write: false })
      if ('response' in guard) return guard.response

      const output = (await executeProcedure('export.run', {
        organizationId: guard.caller.organizationId,
        actor: guard.caller.actor,
        role: guard.caller.role as never,
        permissions: guard.caller.permissions,
        input: { resource },
        requestId,
        ipAddress: clientIp(c.req.raw.headers),
        userAgent: c.req.raw.headers.get('user-agent') ?? undefined,
      })) as { columns: string[]; rows: Array<Record<string, unknown>> }

      const filename = exportFilename(resource as ExportResource, new Date().toISOString().slice(0, 10))
      c.header('Content-Type', 'text/csv; charset=utf-8')
      c.header('Content-Disposition', `attachment; filename="${filename}"`)
      // Never sniffed as HTML, never cached by anything shared.
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('Cache-Control', 'no-store')
      return c.body(toCsv(output.columns, output.rows))
    } catch (error) {
      const { status, body } = toApiError(error, requestId)
      return c.json(body, status as 500)
    }
  })
}

function mount(app: Hono<ApiEnv>, procedure: AnyProcedure) {
  // OpenAPI writes `{id}`; Hono expects `:id`.
  const honoPath = procedure.http.path.replace(/\{(\w+)\}/g, ':$1')
  const method = procedure.http.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'

  app[method](honoPath, async (c) => {
    const requestId = newId()
    c.set('requestId', requestId)

    try {
      const klass = procedure.rateLimit ?? (procedure.readOnly ? 'read' : 'write')
      const guard = await authorize(c, { requestId, klass, write: procedure.http.method !== 'GET' })
      if ('response' in guard) return guard.response
      const resolution = guard.caller

      const output = await executeProcedure(procedure.name, {
        organizationId: resolution.organizationId,
        actor: resolution.actor,
        role: resolution.role as never,
        permissions: resolution.permissions,
        input: await readInput(c, procedure),
        requestId,
        ipAddress: clientIp(c.req.raw.headers),
        userAgent: c.req.raw.headers.get('user-agent') ?? undefined,
        idempotencyKey: c.req.raw.headers.get('idempotency-key') ?? undefined,
        onReplay: () => c.header('Idempotent-Replayed', 'true'),
      })

      const status = procedure.http.successStatus ?? 200
      return c.json(output as object, status as 200)
    } catch (error) {
      const { status, body } = toApiError(error, requestId)
      return c.json(body, status as 500)
    }
  })
}

/** Rate limits are per actor; system and job actors share one bucket each. */
function actorKey(actor: { type: string; id?: string }): string {
  return actor.id ?? actor.type
}

/** Path parameters, query string, and JSON body merged into one input object. */
async function readInput(
  c: Context<ApiEnv, string>,
  procedure: AnyProcedure,
): Promise<unknown> {
  const input: Record<string, unknown> = {
    ...c.req.query(),
    ...c.req.param(),
  }

  if (procedure.http.method !== 'GET' && procedure.http.method !== 'DELETE') {
    const contentType = c.req.raw.headers.get('content-type') ?? ''
    if (procedure.http.body === 'multipart' && contentType.includes('multipart/form-data')) {
      // Files arrive as File objects; the procedure's schema validates them.
      Object.assign(input, await c.req.parseBody())
    } else if (contentType.includes('application/json')) {
      try {
        const body = await c.req.json()
        if (body && typeof body === 'object') Object.assign(input, body)
      } catch {
        // An unparseable body is left to schema validation, which produces a
        // far more useful message than "invalid JSON".
      }
    }
  }

  return input
}

function unauthorizedMessage(reason: string): string {
  switch (reason) {
    case 'invalid-key':
      return 'The API key is unknown, revoked, or expired.'
    case 'no-organization':
      return 'The session has no active organization. Select one first.'
    case 'not-a-member':
      return 'No such organization.'
    default:
      return 'Authentication is required.'
  }
}

/**
 * Trusts x-forwarded-for only for the audit trail, never for authorisation --
 * the header is caller-supplied and trivially forged.
 */
function clientIp(headers: Headers): string | undefined {
  const forwarded = headers.get('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() || undefined
}
