import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { db, closePool } from './client.ts'

/**
 * Applies pending migrations.
 *
 * Runs under a PostgreSQL advisory lock so that concurrent boots -- two
 * replicas starting together, or a deploy overlapping the previous
 * container -- cannot apply the same migration twice. v0.1 ships a single
 * replica, but the failure this prevents is a corrupted schema, and the fix
 * is one line.
 */

/** Arbitrary but fixed. Any constant works; it must simply never change. */
const MIGRATION_LOCK_ID = 8_472_119_004

/**
 * Where the migration files are.
 *
 * Beside this module when the application runs from the repository. They are
 * plain `.sql` files and a journal, not modules, so a bundler does not carry
 * them: a bundled server -- the container -- sets `WORKLOOM_MIGRATIONS_DIR` to
 * where it put them instead. Without that, the app would boot against whatever
 * schema happened to be there, which is a far worse failure than refusing to
 * start.
 */
export function migrationsFolder(): string {
  return process.env.WORKLOOM_MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), 'migrations')
}

export async function runMigrations(): Promise<void> {
  const folder = migrationsFolder()

  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`)
  try {
    await migrate(db, { migrationsFolder: folder })
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('migrations: up to date')
      return closePool()
    })
    .catch(async (error: unknown) => {
      console.error('migrations: failed\n', error)
      await closePool()
      process.exit(1)
    })
}
