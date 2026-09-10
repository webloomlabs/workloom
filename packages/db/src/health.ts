import { sql } from 'drizzle-orm'
import { db } from './client.ts'

export type HealthCheck = { status: 'ok' | 'error'; detail?: string; latencyMs?: number }

/**
 * Database health, for the /api/health endpoint.
 *
 * Lives here rather than in the route so that the web app never imports the
 * ORM directly -- data access stays behind this package, which is what keeps
 * the same queries callable from the worker and the CLI.
 */
export async function checkDatabase(): Promise<HealthCheck> {
  const started = performance.now()
  try {
    await db.execute(sql`select 1`)
    return { status: 'ok', latencyMs: Math.round(performance.now() - started) }
  } catch (error) {
    return { status: 'error', detail: (error as Error).message }
  }
}

export async function checkMigrations(): Promise<HealthCheck> {
  try {
    const { rows } = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    )
    return { status: 'ok', detail: `${rows[0]?.count ?? 0} applied` }
  } catch {
    // The bookkeeping table does not exist until the first migration runs.
    return { status: 'ok', detail: 'none applied' }
  }
}
