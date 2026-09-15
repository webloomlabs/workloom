// Re-exported so consumers never depend on drizzle-orm directly: data access
// belongs behind this package, and a direct dependency also drags in drizzle's
// peer requirements (pg, kysely) into every package that only wanted `eq`.
export {
  sql,
  and,
  or,
  not,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  like,
  ilike,
  between,
  asc,
  desc,
  count,
  sum,
  max,
  countDistinct,
} from 'drizzle-orm'
export type { SQL } from 'drizzle-orm'
// For joining one table twice under different names.
export { alias } from 'drizzle-orm/pg-core'
export { db, getPool, closePool, type Database } from './client.ts'
export { withTenant, withoutTenant, currentTenant, type TenantTransaction } from './tenant.ts'
export { runMigrations } from './migrate.ts'
export {
  assertIsolationIntact,
  findIsolationViolations,
  IsolationError,
  type IsolationViolation,
  type IsolationHandle,
} from './isolation.ts'
export { checkDatabase, checkMigrations, type HealthCheck } from './health.ts'
export * as schema from './schema/index.ts'
