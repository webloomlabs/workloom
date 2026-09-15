import { schema, type TenantTransaction } from '@workloom/db'
import { newId } from './ids.ts'
import type { Actor, AuditEntry } from './context.ts'

/**
 * Writes an audit entry inside the caller's transaction.
 *
 * Because it shares the transaction, an audited change and its record commit
 * or roll back together. There is no window in which the change happened but
 * the log does not say so.
 */
export async function writeAuditEntry(
  tx: TenantTransaction,
  options: {
    organizationId: string
    actor: Actor
    requestId: string
    ipAddress?: string | undefined
    userAgent?: string | undefined
    entry: AuditEntry
  },
): Promise<void> {
  const { actor } = options
  await tx.insert(schema.auditLogs).values({
    id: newId(),
    organizationId: options.organizationId,
    actorType: actor.type === 'apiKey' ? 'api_key' : actor.type,
    actorId: actor.type === 'user' ? actor.id : actor.type === 'apiKey' ? actor.userId : null,
    actorLabel: actor.label,
    action: options.entry.action,
    entityType: options.entry.entityType,
    entityId: options.entry.entityId ?? null,
    entityLabel: options.entry.entityLabel ?? null,
    changes: options.entry.changes ?? null,
    requestId: options.requestId,
    ipAddress: options.ipAddress ?? null,
    userAgent: options.userAgent ?? null,
  })
}

/**
 * Reduces a before/after pair to just what changed.
 *
 * Storing whole rows would make the log expensive and, worse, would copy
 * sensitive values into a table that is deliberately hard to delete from.
 */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): Record<string, { from: unknown; to: unknown }> | undefined {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const [key, next] of Object.entries(after)) {
    const previous = before[key]
    if (!Object.is(previous, next) && JSON.stringify(previous) !== JSON.stringify(next)) {
      changes[key] = { from: previous, to: next }
    }
  }
  return Object.keys(changes).length > 0 ? changes : undefined
}
