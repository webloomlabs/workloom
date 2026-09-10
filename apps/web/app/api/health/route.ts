import { checkDatabase, checkMigrations, type HealthCheck } from '@workloom/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Health endpoint.
 *
 * Deliberately unauthenticated and deliberately terse: it is consumed by
 * container orchestrators and uptime monitors, and it must not become a
 * reconnaissance surface. It reports whether the process can serve traffic,
 * not what the process contains.
 */
export async function GET() {
  const [database, migrations] = await Promise.all([checkDatabase(), checkMigrations()])
  const checks: Record<string, HealthCheck> = { database, migrations }
  const healthy = Object.values(checks).every((c) => c.status === 'ok')

  return Response.json(
    { status: healthy ? 'ok' : 'degraded', checks, uptimeSeconds: Math.round(process.uptime()) },
    { status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  )
}
