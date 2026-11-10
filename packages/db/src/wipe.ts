import { sql } from 'drizzle-orm'
import { currentTenant, type TenantTransaction } from './tenant.ts'

/**
 * Removing every record an organization has: the data behind an owner's
 * "reset organization".
 *
 * What is tenant data is read from the catalogue, not listed: every table
 * under row-level security with an `organization_id`. A table added next year
 * is wiped without anyone remembering to add it here -- the same reasoning as
 * the isolation checks in ./isolation.ts.
 *
 * Kept: the organization row and its members (Better Auth's tables, which are
 * not under row-level security, so never match), and the audit log with its
 * seals, which the application role cannot delete from anyway. A reset is
 * itself audited, and the log is what says it happened.
 */
export const KEPT_ON_WIPE = ['audit_logs', 'audit_seals'] as const

/** A foreign key between two wiped tables: `child` holds the reference. */
export type WipeEdge = { child: string; parent: string }

/**
 * The order to delete in: every table after all the tables that reference it.
 *
 * The foreign keys between domain tables are mostly NO ACTION -- a parent
 * cannot go while a child points at it -- so children go first. A table that
 * references itself is fine in one statement. A cycle between two tables has
 * no such order, and there is none today; if one is ever added this refuses,
 * by name, rather than leave a reset half done (it runs in one transaction,
 * so nothing would be left half done, but the reason should be legible).
 */
export function deletionOrder(tables: readonly string[], edges: readonly WipeEdge[]): string[] {
  const included = new Set(tables)
  // parent -> the children that still reference it
  const referencedBy = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]))
  for (const { child, parent } of edges) {
    if (child === parent || !included.has(child) || !included.has(parent)) continue
    referencedBy.get(parent)!.add(child)
  }

  const order: string[] = []
  const remaining = new Set(tables)
  while (remaining.size > 0) {
    // Sorted, so the order -- and so any error -- is the same on every run.
    const ready = [...remaining].filter((t) => referencedBy.get(t)!.size === 0).sort()
    if (ready.length === 0) {
      throw new Error(
        `wipe: the foreign keys between these tables form a cycle, so no delete order exists: ${[...remaining].sort().join(', ')}`,
      )
    }
    for (const table of ready) {
      order.push(table)
      remaining.delete(table)
      for (const children of referencedBy.values()) children.delete(table)
    }
  }
  return order
}

async function tenantTables(tx: TenantTransaction): Promise<string[]> {
  const kept = sql.raw(KEPT_ON_WIPE.map((t) => `'${t}'`).join(', '))
  const { rows } = await tx.execute<{ table: string }>(sql`
    select c.relname as table
    from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
        and a.attname = 'organization_id' and a.attnum > 0 and not a.attisdropped
    where c.relkind = 'r' and n.nspname = 'public'
      and c.relrowsecurity
      and c.relname not in (${kept})
  `)
  return rows.map((r) => r.table)
}

async function foreignKeys(tx: TenantTransaction): Promise<WipeEdge[]> {
  const { rows } = await tx.execute<WipeEdge>(sql`
    select child.relname as child, parent.relname as parent
    from pg_constraint k
      join pg_class child on child.oid = k.conrelid
      join pg_class parent on parent.oid = k.confrelid
      join pg_namespace n on n.oid = child.relnamespace
    where k.contype = 'f' and n.nspname = 'public'
  `)
  return rows
}

/**
 * Deletes every record of the organization the transaction is scoped to, and
 * returns how many rows went from each table.
 *
 * Must run inside `withTenant(organizationId, ...)`: row-level security is
 * what confines the deletes to one organization, and each statement names it
 * as well. Setting `workloom.wipe_org` is what lets the guard triggers stand
 * aside (migration 0048); it is transaction-local, like the tenant scope, and
 * cleared again before returning so that anything the caller does afterwards
 * in the same transaction is guarded as usual.
 *
 * This authorises nothing. The caller decides who may; see
 * packages/auth/src/organization-reset.ts, the only caller.
 */
export async function wipeTenantData(tx: TenantTransaction, organizationId: string): Promise<Record<string, number>> {
  const scope = await currentTenant(tx)
  if (scope !== organizationId) {
    throw new Error(`wipe: the transaction is scoped to ${scope ?? 'no organization'}, not ${organizationId}`)
  }

  const order = deletionOrder(await tenantTables(tx), await foreignKeys(tx))

  await tx.execute(sql`select set_config('workloom.wipe_org', ${organizationId}, true)`)
  const deleted: Record<string, number> = {}
  for (const table of order) {
    const result = await tx.execute(
      sql`delete from ${sql.identifier(table)} where organization_id = ${organizationId}::uuid`,
    )
    deleted[table] = result.rowCount ?? 0
  }
  await tx.execute(sql`select set_config('workloom.wipe_org', '', true)`)

  return deleted
}
