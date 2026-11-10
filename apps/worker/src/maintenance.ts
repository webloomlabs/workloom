import { pruneRateLimits } from '@workloom/core'
import { expireDueQuotes, generateDueInvoices, markOverdueInvoices, placeRecordedMoney, sealAuditLog, sweepExpiringAssets, sweepProjectBudgets } from '@workloom/core/modules'
import { buildContext, type TransactionHooks } from '@workloom/core/registry'
import { and, db, lt, notInArray, schema, withTenant } from '@workloom/db'

/** Replays are honoured for a day; after that a key may be reused. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Expired OAuth tokens are kept a week, so a used refresh token presented
 * again is still recognised as a reuse rather than as an unknown token.
 */
const OAUTH_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** A registered app that nobody has connected within a day is abandoned. */
const OAUTH_CLIENT_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Periodic cleanup, and the state changes that happen with the passing of time:
 * quotes that have run out of validity, invoices that have gone past their due
 * date without being paid, retainers whose next period has arrived, and
 * domains and certificates approaching their renewal.
 *
 * Idempotency keys are tenant data, so they are pruned the documented way for
 * cross-organization work: enumerate organizations, then one tenant-scoped
 * transaction each. Hourly, that is cheap even for many organizations, and it
 * means the dispatcher's wider policy never needs to cover this table.
 */
export async function runMaintenance(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS)
  const organizations = await db.select({ id: schema.organization.id }).from(schema.organization)
  const oauthClientsInUse = new Set<string>()

  for (const { id } of organizations) {
    await withTenant(id, (tx) =>
      tx.delete(schema.idempotencyKeys).where(lt(schema.idempotencyKeys.createdAt, cutoff)),
    )
    await withTenant(id, async (tx) => {
      await tx
        .delete(schema.oauthTokens)
        .where(lt(schema.oauthTokens.expiresAt, new Date(now.getTime() - OAUTH_TOKEN_RETENTION_MS)))
      const grants = await tx.selectDistinct({ clientId: schema.oauthGrants.clientId }).from(schema.oauthGrants)
      for (const { clientId } of grants) oauthClientsInUse.add(clientId)
    })
    // Each organization separately, so one failure cannot stop quotes expiring
    // or invoices going overdue elsewhere. Both are decided in the
    // organization's own time zone, which is what "today" means to it.
    await sweep(id, 'quote expiry', expireDueQuotes, 'expired %n quote(s)', now)
    await sweep(id, 'overdue invoices', markOverdueInvoices, 'swept %n invoice(s) past their due date', now)
    // Raises drafts only: nothing is issued or sent without a person.
    await sweep(id, 'recurring billing', generateDueInvoices, 'raised %n draft invoice(s) from schedules', now)
    await sweep(id, 'expiring infrastructure', sweepExpiringAssets, 'announced %n asset(s) approaching renewal', now)
    // Once per threshold per budget period: a retainer over in March hears it once in March.
    await sweep(id, 'project budgets', (ctx) => sweepProjectBudgets(ctx), 'raised %n budget alert(s)', now)
    // Payments and expenses recorded against an account before their lines were kept: placed once.
    await sweep(id, 'bank lines', placeRecordedMoney, 'placed %n recorded payment(s) and expense(s) in their accounts', now)
    // Each finished day of the audit log, sealed so a later edit shows.
    await sweep(id, 'audit seals', sealAuditLog, 'sealed %n day(s) of the audit log', now)
  }

  await pruneOAuthClients(oauthClientsInUse, now)
  await pruneRateLimits()
}

/**
 * Dynamic client registration is open to anyone, so registrations nobody
 * ever connected are cleared away.
 *
 * Which clients are in use is gathered organization by organization above.
 * Asking the database "has this client any grants?" from here would be
 * wrong in the dangerous direction: grants are under row-level security,
 * an unscoped query sees none of them, and deleting a client cascades to
 * its grants.
 */
async function pruneOAuthClients(inUse: ReadonlySet<string>, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - OAUTH_CLIENT_GRACE_MS)
  const removed = await db
    .delete(schema.oauthClients)
    .where(
      inUse.size > 0
        ? and(lt(schema.oauthClients.createdAt, cutoff), notInArray(schema.oauthClients.id, [...inUse]))
        : lt(schema.oauthClients.createdAt, cutoff),
    )
    .returning({ id: schema.oauthClients.id })
  if (removed.length > 0) console.log(`worker: removed ${removed.length} unused OAuth client registration(s)`)
}

/** One organization's periodic state change, as a job actor, failing alone. */
async function sweep(
  organizationId: string,
  label: string,
  run: (ctx: ReturnType<typeof buildContext>) => Promise<number>,
  message: string,
  now: Date,
): Promise<void> {
  // What a sweep leaves to do once its changes are safe -- an email, a file
  // removed -- runs after the commit, as it does for a procedure, and is
  // dropped if the sweep rolls back.
  const hooks: TransactionHooks = { commit: [], rollback: [] }
  try {
    const changed = await withTenant(organizationId, (tx) =>
      run(buildContext({ organizationId, actor: { type: 'job', label }, role: null, permissions: new Set(), now }, tx, hooks)),
    )
    if (changed > 0) console.log(`worker: ${message.replace('%n', String(changed))} in ${organizationId}`)
  } catch (error) {
    console.error(`worker: ${label} failed in ${organizationId}`, error)
    await settle(hooks.rollback, label, organizationId)
    return
  }
  await settle(hooks.commit, label, organizationId)
}

async function settle(tasks: Array<() => Promise<void>>, label: string, organizationId: string): Promise<void> {
  for (const task of tasks) {
    try {
      await task()
    } catch (error) {
      console.error(`worker: after ${label} in ${organizationId}`, error)
    }
  }
}
