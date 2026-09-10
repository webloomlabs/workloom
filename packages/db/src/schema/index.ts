/**
 * Drizzle schema.
 *
 * Every domain table declared here must:
 *   1. carry `organization_id uuid NOT NULL` -- including deep child tables
 *      where it is technically derivable from the parent, because RLS
 *      policies must filter locally rather than joining upward;
 *   2. lead its primary index with `organization_id`;
 *   3. have a row-level security policy in a migration under src/migrations.
 *
 * These are enforced by the tenant-isolation test suite, not by convention.
 * Adding a table without a policy fails CI.
 *
 * Tables owned by Better Auth (user, session, account, verification,
 * organization, member, invitation, apikey) are deliberately NOT tenant
 * -scoped -- see packages/db/src/tenant.ts for why.
 */

// Populated from S1 onward. S0 ships the harness that will police them.
export {}
