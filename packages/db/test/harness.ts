import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'

/**
 * Test database harness.
 *
 * Isolation cannot be tested against a mock, and it cannot be meaningfully
 * tested against a connection that happens to be a superuser -- which is what
 * a naive test setup produces, because the default Postgres user is one. So
 * the harness reproduces the real deployment shape: an unprivileged role that
 * owns its tables and is subject to FORCE ROW LEVEL SECURITY.
 *
 * By default a throwaway container is started. Set TEST_DATABASE_URL to reuse
 * a running Postgres instead (much faster locally); it must point at a
 * superuser, since the harness creates roles and databases.
 */

const APP_ROLE = 'workloom_app_test'
const APP_PASSWORD = 'test_password'

export type TestDatabase = {
  /** Connection string for the unprivileged application role. */
  url: string
  /** Connection string for the owning superuser, for setup and assertions. */
  adminUrl: string
  stop: () => Promise<void>
}

export async function startTestDatabase(): Promise<TestDatabase> {
  let adminUrl: string
  let container: StartedPostgreSqlContainer | undefined

  if (process.env.TEST_DATABASE_URL) {
    adminUrl = process.env.TEST_DATABASE_URL
  } else {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    adminUrl = container.getConnectionUri()
  }

  const dbName = `workloom_test_${process.env.VITEST_WORKER_ID ?? '0'}_${Date.now()}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()

  await admin.query(`DROP DATABASE IF EXISTS ${quote(dbName)}`)
  const { rowCount } = await admin.query('select 1 from pg_roles where rolname = $1', [APP_ROLE])
  if (rowCount === 0) {
    await admin.query(
      `CREATE ROLE ${quote(APP_ROLE)} WITH LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS ` +
        `PASSWORD '${APP_PASSWORD}'`,
    )
  }
  await admin.query(`CREATE DATABASE ${quote(dbName)} OWNER ${quote(APP_ROLE)}`)
  await admin.end()

  const target = new pg.Client({ connectionString: replaceDatabase(adminUrl, dbName) })
  await target.connect()
  await target.query(`ALTER SCHEMA public OWNER TO ${quote(APP_ROLE)}`)
  await target.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')
  await target.query(`GRANT ALL ON SCHEMA public TO ${quote(APP_ROLE)}`)
  await target.end()

  const url = buildUrl(adminUrl, dbName, APP_ROLE, APP_PASSWORD)

  return {
    url,
    adminUrl: replaceDatabase(adminUrl, dbName),
    stop: async () => {
      await container?.stop()
    },
  }
}

/**
 * Sets the environment the application expects, then imports the database
 * package. The import must happen afterwards: the connection pool is created
 * when the module is first evaluated.
 */
export async function loadDbWithEnv(databaseUrl: string) {
  process.env.DATABASE_URL = databaseUrl
  process.env.NODE_ENV = 'test'
  process.env.APP_URL ??= 'http://localhost:3000'
  process.env.BETTER_AUTH_SECRET ??= 'a'.repeat(32)
  process.env.WORKLOOM_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')
  process.env.SMTP_HOST ??= 'localhost'
  process.env.MAIL_FROM ??= 'test@example.com'
  return import('../src/index.ts')
}

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) throw new Error(`unsafe identifier: ${identifier}`)
  return `"${identifier}"`
}

function replaceDatabase(url: string, dbName: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${dbName}`
  return parsed.toString()
}

function buildUrl(base: string, dbName: string, user: string, password: string): string {
  const parsed = new URL(base)
  parsed.pathname = `/${dbName}`
  parsed.username = user
  parsed.password = password
  return parsed.toString()
}
