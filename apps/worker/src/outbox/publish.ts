import { matchesAny, newId } from '@workloom/core'
import { asc, inArray, isNull, schema } from '@workloom/db'
import { withDispatcher } from './scope.ts'

/**
 * Publishes a batch of outbox events: one delivery row per matching endpoint,
 * then the events are stamped as published -- all in one transaction, so an
 * event is never marked published without its deliveries existing.
 *
 * `FOR UPDATE SKIP LOCKED` lets several workers run at once: each claims a
 * different batch instead of blocking on, or double-publishing, the same rows.
 *
 * Returns the number of events published; a full batch means there may be more.
 */
export async function publishPendingEvents(limit = 100): Promise<number> {
  return withDispatcher(async (tx) => {
    const pending = await tx
      .select({
        id: schema.events.id,
        organizationId: schema.events.organizationId,
        type: schema.events.type,
        data: schema.events.data,
      })
      .from(schema.events)
      .where(isNull(schema.events.publishedAt))
      .orderBy(asc(schema.events.id))
      .limit(limit)
      .for('update', { skipLocked: true })

    if (pending.length === 0) return 0

    const organizationIds = [...new Set(pending.map((e) => e.organizationId))]
    const endpoints = await tx
      .select({
        id: schema.webhookEndpoints.id,
        organizationId: schema.webhookEndpoints.organizationId,
        eventTypes: schema.webhookEndpoints.eventTypes,
        enabled: schema.webhookEndpoints.enabled,
      })
      .from(schema.webhookEndpoints)
      .where(inArray(schema.webhookEndpoints.organizationId, organizationIds))

    const now = new Date()
    const deliveries: Array<typeof schema.webhookDeliveries.$inferInsert> = []

    for (const event of pending) {
      const sameOrganization = endpoints.filter((e) => e.organizationId === event.organizationId)
      const targets =
        event.type === 'webhook.test'
          ? // A test goes to the endpoint it names and nowhere else, enabled or not.
            sameOrganization.filter((e) => e.id === (event.data as { endpointId?: string }).endpointId)
          : sameOrganization.filter((e) => e.enabled && matchesAny(event.type, e.eventTypes))

      for (const endpoint of targets) {
        deliveries.push({
          id: newId(),
          organizationId: event.organizationId,
          endpointId: endpoint.id,
          eventId: event.id,
          eventType: event.type,
          status: 'pending',
          nextAttemptAt: now,
        })
      }
    }

    if (deliveries.length > 0) await tx.insert(schema.webhookDeliveries).values(deliveries)
    await tx
      .update(schema.events)
      .set({ publishedAt: now })
      .where(
        inArray(
          schema.events.id,
          pending.map((e) => e.id),
        ),
      )

    return pending.length
  })
}
