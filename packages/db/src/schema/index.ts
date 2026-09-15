/**
 * Drizzle schema.
 *
 * Every domain table declared here must:
 *   1. carry `organization_id uuid NOT NULL` -- including deep child tables
 *      where it is derivable from the parent, because RLS policies must
 *      filter locally rather than joining upward;
 *   2. lead its primary index with `organization_id`;
 *   3. have a row-level security policy in a migration under src/migrations.
 *
 * These are enforced by packages/db/test/schema.isolation.test.ts, not by
 * convention. Adding a table without a policy fails CI.
 *
 * The Better Auth tables in ./auth.ts are the documented exception -- see
 * docs/architecture.md.
 */

export * from './auth.ts'
export * from './columns.ts'
export * from './audit.ts'
export * from './api-keys.ts'
export * from './rate-limits.ts'
