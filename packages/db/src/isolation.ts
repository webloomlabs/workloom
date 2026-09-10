import { sql } from 'drizzle-orm'
import { db, type Database } from './client.ts'

/**
 * Tenant-isolation invariants.
 *
 * Run at boot (see apps/web/instrumentation.ts) and as a dedicated CI job.
 * The checks are introspective rather than enumerated, so they automatically
 * cover tables that do not exist yet: adding a tenant table without a policy
 * fails without anyone remembering to update a list.
 */

/**
 * Tables owned by Better Auth. Deliberately not tenant-scoped.
 *
 * A user is not org-scoped -- they can belong to several organizations, and
 * the question "which organizations does this user belong to?" has to be
 * answerable before any organization context exists. Under RLS it would
 * return nothing. Membership is enforced in packages/auth/resolve-actor
 * instead, which carries its own test suite.
 */
const UNSCOPED_TABLES = [
  'user',
  'session',
  'account',
  'verification',
  'organization',
  'member',
  'invitation',
  'apikey',
  '__drizzle_migrations',
] as const

export type IsolationViolation = { check: string; object: string; detail: string }

const excluded = sql.raw(UNSCOPED_TABLES.map((t) => `'${t}'`).join(', '))

/** The connection must not be a superuser: superusers bypass RLS outright. */
async function checkNotSuperuser(handle: Database): Promise<IsolationViolation[]> {
  const { rows } = await handle.execute<{ is_superuser: boolean; role: string }>(
    sql`select current_setting('is_superuser') = 'on' as is_superuser, current_user as role`,
  )
  const row = rows[0]
  if (!row?.is_superuser) return []
  return [
    {
      check: 'not-superuser',
      object: row.role,
      detail:
        'the application is connected as a database superuser, which bypasses row-level ' +
        'security entirely -- every organization can read every other organization\'s data. ' +
        'Connect as an unprivileged role (the bundled docker-compose creates workloom_app).',
    },
  ]
}

/** Every table with organization_id has RLS enabled AND forced. */
async function checkRlsEnabled(handle: Database): Promise<IsolationViolation[]> {
  const { rows } = await handle.execute<{ table: string; enabled: boolean; forced: boolean }>(sql`
    select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
    from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
        and a.attname = 'organization_id' and a.attnum > 0 and not a.attisdropped
    where c.relkind = 'r' and n.nspname = 'public'
      and c.relname not in (${excluded})
      and not (c.relrowsecurity and c.relforcerowsecurity)
  `)
  return rows.map((r) => ({
    check: 'rls-enabled',
    object: r.table,
    detail: r.enabled
      ? 'row-level security is enabled but not FORCED, so the table owner bypasses it -- ' +
        'and the application owns its tables. Add FORCE ROW LEVEL SECURITY.'
      : 'has an organization_id column but no row-level security. Add ENABLE and FORCE ' +
        'ROW LEVEL SECURITY plus a tenant_isolation policy.',
  }))
}

/** Every tenant table has a policy covering all four verbs. */
async function checkPolicies(handle: Database): Promise<IsolationViolation[]> {
  const { rows } = await handle.execute<{ table: string; commands: string }>(sql`
    select c.relname as table,
           coalesce(string_agg(distinct p.polcmd::text, ','), '') as commands
    from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
        and a.attname = 'organization_id' and a.attnum > 0 and not a.attisdropped
      left join pg_policy p on p.polrelid = c.oid
    where c.relkind = 'r' and n.nspname = 'public'
      and c.relname not in (${excluded})
    group by c.relname
    having coalesce(string_agg(distinct p.polcmd::text, ','), '') not like '%*%'
  `)
  return rows.map((r) => ({
    check: 'tenant-policy',
    object: r.table,
    detail:
      r.commands === ''
        ? 'has no row-level security policy'
        : `policies cover only [${r.commands}]; a tenant table needs one policy for ALL ` +
          'commands (polcmd "*") with both USING and WITH CHECK',
  }))
}

/** Every tenant table has an index leading with organization_id. */
async function checkIndexes(handle: Database): Promise<IsolationViolation[]> {
  const { rows } = await handle.execute<{ table: string }>(sql`
    select c.relname as table
    from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
        and a.attname = 'organization_id' and a.attnum > 0 and not a.attisdropped
    where c.relkind = 'r' and n.nspname = 'public'
      and c.relname not in (${excluded})
      and not exists (
        select 1 from pg_index i
        where i.indrelid = c.oid and i.indnatts > 0 and i.indkey[0] = a.attnum
      )
  `)
  return rows.map((r) => ({
    check: 'tenant-index',
    object: r.table,
    detail:
      'no index leads with organization_id. Every tenant query filters on it first, so ' +
      'without such an index the RLS predicate forces a sequential scan.',
  }))
}

/**
 * Every view sets security_invoker.
 *
 * This is the sharpest edge in the whole design. A view over RLS-protected
 * tables executes with the view OWNER's privileges by default, which silently
 * bypasses every tenant policy. Nothing about it looks wrong, and a test that
 * exercises a single organization sees entirely correct data.
 */
async function checkViews(handle: Database): Promise<IsolationViolation[]> {
  const { rows } = await handle.execute<{ view: string }>(sql`
    select c.relname as view
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'v' and n.nspname = 'public'
      and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=true%'
  `)
  return rows.map((r) => ({
    check: 'view-security-invoker',
    object: r.view,
    detail:
      'is not defined WITH (security_invoker = true), so it runs with the view owner\'s ' +
      'privileges and bypasses row-level security -- a cross-tenant data leak.',
  }))
}

export async function findIsolationViolations(
  handle: Database = db,
): Promise<IsolationViolation[]> {
  const results = await Promise.all([
    checkNotSuperuser(handle),
    checkRlsEnabled(handle),
    checkPolicies(handle),
    checkIndexes(handle),
    checkViews(handle),
  ])
  return results.flat()
}

export class IsolationError extends Error {
  constructor(readonly violations: IsolationViolation[]) {
    const lines = violations.map((v) => `  [${v.check}] ${v.object}\n      ${v.detail}`)
    super(
      `Tenant isolation is not intact. Refusing to start.\n\n${lines.join('\n\n')}\n\n` +
        `Data belonging to different organizations could otherwise be exposed to each other.\n` +
        `See docs/architecture for the isolation model.\n`,
    )
    this.name = 'IsolationError'
  }
}

/**
 * Boot gate. Throws unless isolation is intact.
 *
 * Designing row-level security and actually having it in production are
 * different things -- the usual way installs end up without it is a
 * self-hoster pointing DATABASE_URL at the superuser their platform handed
 * them. Failing loudly at boot is what closes that gap.
 */
export async function assertIsolationIntact(handle: Database = db): Promise<void> {
  const violations = await findIsolationViolations(handle)
  if (violations.length > 0) throw new IsolationError(violations)
}
