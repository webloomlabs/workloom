import { env } from '@workloom/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema/index.ts'

/**
 * PostgreSQL connection pool.
 *
 * `pg` parses int8 (bigint) columns into JavaScript numbers by default, which
 * silently loses precision above 2^53. Every monetary value in Workloom is a
 * bigint of minor currency units, so this default would corrupt money. Return
 * them as strings and let the Money primitive parse them into BigInt.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value)

/**
 * `numeric` likewise arrives as a string, which is correct -- do not "fix" it
 * by parsing to a float. Quantities and tax rates are parsed as exact decimals.
 */

let pool: pg.Pool | undefined

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_SIZE,
    application_name: 'workloom',
  })
  return pool
}

/**
 * The unscoped database handle.
 *
 * Importing this outside the allowlist in eslint.config.js is a lint error.
 * Tenant data is reached through `withTenant` so that row-level security has
 * an organization to filter by; a query issued here sees nothing at all,
 * because the policies compare against an unset setting.
 *
 * Legitimate callers: migrations, Better Auth (whose tables are not tenant
 * -scoped), the outbox dispatcher (which enumerates organizations), and the
 * boot-time isolation self-test.
 */
export const db = drizzle(getPool(), { schema, casing: 'snake_case' })

export type Database = typeof db

export async function closePool(): Promise<void> {
  await pool?.end()
  pool = undefined
}
