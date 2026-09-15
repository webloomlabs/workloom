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

export type Database = ReturnType<typeof createDatabase>

function createDatabase() {
  return drizzle(getPool(), { schema, casing: 'snake_case' })
}

let instance: Database | undefined

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
 *
 * Resolved lazily, on first use. Opening a connection pool as a side effect of
 * an `import` is a trap: any module that merely wants a type or a helper binds
 * the pool to whatever DATABASE_URL happened to be set at load time. In tests
 * that silently pointed at the developer's own database instead of the
 * throwaway one -- which looks like passing tests until the data collides.
 */
export const db: Database = new Proxy({} as Database, {
  get(_, property, receiver) {
    instance ??= createDatabase()
    return Reflect.get(instance, property, receiver)
  },
  has(_, property) {
    instance ??= createDatabase()
    return Reflect.has(instance, property)
  },
})

export async function closePool(): Promise<void> {
  await pool?.end()
  pool = undefined
  instance = undefined
}
