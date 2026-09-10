/**
 * Boot sequence.
 *
 * Next calls `register()` once per server process, before handling any
 * request. Three things happen here, in order, and any of them may refuse to
 * let the process start:
 *
 *   1. Configuration is parsed and validated.
 *   2. Pending migrations are applied (under an advisory lock).
 *   3. Tenant isolation is verified against the live database.
 *
 * Step 3 is the important one. Row-level security that is silently switched
 * off looks exactly like row-level security that works, right up until one
 * agency reads another agency's client list. The usual cause is a
 * DATABASE_URL pointing at a superuser, and the only reliable defence is to
 * check at boot and refuse to run.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { loadEnv } = await import('@workloom/config')
  const config = loadEnv()

  const { runMigrations, assertIsolationIntact } = await import('@workloom/db')

  await runMigrations()
  console.log('boot: migrations up to date')

  try {
    await assertIsolationIntact()
    console.log('boot: tenant isolation verified')
  } catch (error) {
    if (config.DANGEROUSLY_ALLOW_SUPERUSER_DB && config.NODE_ENV !== 'production') {
      console.warn(
        `boot: tenant isolation checks FAILED, continuing because ` +
          `DANGEROUSLY_ALLOW_SUPERUSER_DB is set.\n${(error as Error).message}`,
      )
    } else {
      throw error
    }
  }
}
