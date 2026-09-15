import { env } from '@workloom/config'
import {
  decryptSecret,
  deliverWebhook,
  DISABLE_AFTER_CONSECUTIVE_FAILURES,
  nextRetryDelay,
  signPayload,
  SIGNATURE_HEADER,
  type DeliveryResult,
} from '@workloom/core'
import { and, asc, eq, inArray, isNull, lte, or, schema, sql } from '@workloom/db'
import { withDispatcher } from './scope.ts'

/**
 * A claimed delivery is hidden from other workers for this long. Comfortably
 * longer than one attempt (a 10 s timeout); if a worker dies mid-attempt the
 * delivery becomes claimable again when the lease lapses, so a crash delays a
 * delivery rather than losing it.
 */
const LEASE_MS = 2 * 60 * 1000

type Claimed = {
  delivery: typeof schema.webhookDeliveries.$inferSelect
  endpoint: typeof schema.webhookEndpoints.$inferSelect
  event: typeof schema.events.$inferSelect
}

/** Claims due deliveries, taking a lease and counting the attempt up front. */
async function claimDue(limit: number, now: Date): Promise<Claimed[]> {
  return withDispatcher(async (tx) => {
    const due = await tx
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.status, 'pending'),
          lte(schema.webhookDeliveries.nextAttemptAt, now),
          or(isNull(schema.webhookDeliveries.lockedUntil), lte(schema.webhookDeliveries.lockedUntil, now)),
        ),
      )
      .orderBy(asc(schema.webhookDeliveries.nextAttemptAt))
      .limit(limit)
      .for('update', { skipLocked: true })

    if (due.length === 0) return []

    // The attempt is counted when claimed, not when finished. If the worker
    // dies mid-request, the retry that follows is still correctly numbered and
    // the schedule still ends.
    const deliveries = await tx
      .update(schema.webhookDeliveries)
      .set({
        lockedUntil: new Date(now.getTime() + LEASE_MS),
        attempts: sql`${schema.webhookDeliveries.attempts} + 1`,
        lastAttemptAt: now,
      })
      .where(inArray(schema.webhookDeliveries.id, due.map((d) => d.id)))
      .returning()

    const endpoints = await tx
      .select()
      .from(schema.webhookEndpoints)
      .where(inArray(schema.webhookEndpoints.id, [...new Set(deliveries.map((d) => d.endpointId))]))
    const events = await tx
      .select()
      .from(schema.events)
      .where(inArray(schema.events.id, [...new Set(deliveries.map((d) => d.eventId))]))

    return deliveries.flatMap((delivery) => {
      const endpoint = endpoints.find((e) => e.id === delivery.endpointId)
      const event = events.find((e) => e.id === delivery.eventId)
      return endpoint && event ? [{ delivery, endpoint, event }] : []
    })
  })
}

/**
 * The exact bytes a receiver gets. Built from the stored event, so every
 * attempt of a delivery carries an identical body -- only the signature's
 * timestamp differs between retries.
 */
export function envelope(event: typeof schema.events.$inferSelect): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    version: event.version,
    occurred_at: event.occurredAt.toISOString(),
    organization_id: event.organizationId,
    actor: event.actor,
    data: event.data,
  })
}

function activeSecrets(endpoint: typeof schema.webhookEndpoints.$inferSelect, now: Date): string[] {
  const secrets = [decryptSecret(endpoint.secretEncrypted)]
  if (
    endpoint.previousSecretEncrypted &&
    endpoint.previousSecretExpiresAt &&
    endpoint.previousSecretExpiresAt > now
  ) {
    secrets.push(decryptSecret(endpoint.previousSecretEncrypted))
  }
  return secrets
}

async function attempt(claimed: Claimed, allowPrivate: boolean): Promise<DeliveryResult> {
  const { delivery, endpoint, event } = claimed

  if (!endpoint.enabled && event.type !== 'webhook.test') {
    return { ok: false, status: null, body: null, error: 'endpoint is disabled', durationMs: 0 }
  }

  const now = new Date()
  const body = envelope(event)
  let signature: string
  try {
    signature = signPayload({
      body,
      secrets: activeSecrets(endpoint, now),
      timestamp: Math.floor(now.getTime() / 1000),
    })
  } catch (error) {
    // Almost always a changed WORKLOOM_ENCRYPTION_KEY. Sending unsigned would
    // teach receivers to accept unsigned requests; fail visibly instead.
    return { ok: false, status: null, body: null, error: (error as Error).message, durationMs: 0 }
  }

  return deliverWebhook({
    url: endpoint.url,
    body,
    allowPrivate,
    headers: {
      'user-agent': 'Workloom-Webhooks/1',
      'workloom-event-id': event.id,
      'workloom-event-type': event.type,
      'workloom-delivery-id': delivery.id,
      'workloom-delivery-attempt': String(delivery.attempts),
      [SIGNATURE_HEADER.toLowerCase()]: signature,
    },
  })
}

async function record(claimed: Claimed, result: DeliveryResult): Promise<void> {
  const { delivery, endpoint, event } = claimed
  const now = new Date()
  const isTest = event.type === 'webhook.test'
  const common = {
    lockedUntil: null,
    responseStatus: result.status,
    responseBody: result.body,
    error: result.ok ? null : result.error,
    durationMs: result.durationMs,
  }

  await withDispatcher(async (tx) => {
    if (result.ok) {
      await tx
        .update(schema.webhookDeliveries)
        .set({ ...common, status: 'succeeded', nextAttemptAt: null, completedAt: now })
        .where(eq(schema.webhookDeliveries.id, delivery.id))
      if (endpoint.consecutiveFailures > 0 && !isTest) {
        await tx
          .update(schema.webhookEndpoints)
          .set({ consecutiveFailures: 0 })
          .where(eq(schema.webhookEndpoints.id, endpoint.id))
      }
      return
    }

    // A disabled endpoint, or a test, gets no retries: nothing will change by
    // waiting, and a test result is only useful immediately.
    const delay = !endpoint.enabled || isTest ? null : nextRetryDelay(delivery.attempts)
    if (delay !== null) {
      await tx
        .update(schema.webhookDeliveries)
        .set({ ...common, nextAttemptAt: new Date(now.getTime() + delay * 1000) })
        .where(eq(schema.webhookDeliveries.id, delivery.id))
      return
    }

    await tx
      .update(schema.webhookDeliveries)
      .set({ ...common, status: 'failed', nextAttemptAt: null, completedAt: now })
      .where(eq(schema.webhookDeliveries.id, delivery.id))

    if (isTest || !endpoint.enabled) return

    const [updated] = await tx
      .update(schema.webhookEndpoints)
      .set({ consecutiveFailures: sql`${schema.webhookEndpoints.consecutiveFailures} + 1` })
      .where(eq(schema.webhookEndpoints.id, endpoint.id))
      .returning({ consecutiveFailures: schema.webhookEndpoints.consecutiveFailures })

    if (updated && updated.consecutiveFailures >= DISABLE_AFTER_CONSECUTIVE_FAILURES) {
      await tx
        .update(schema.webhookEndpoints)
        .set({
          enabled: false,
          disabledReason:
            `Disabled automatically after ${updated.consecutiveFailures} deliveries in a row ` +
            `failed every retry. Last error: ${result.error}`,
        })
        .where(eq(schema.webhookEndpoints.id, endpoint.id))
    }
  })
}

/**
 * Attempts every due delivery, up to `limit`, `concurrency` at a time.
 * Returns how many were attempted.
 */
export async function deliverDue(
  options: { limit?: number; concurrency?: number; allowPrivate?: boolean } = {},
): Promise<number> {
  const allowPrivate = options.allowPrivate ?? env.WORKLOOM_ALLOW_PRIVATE_WEBHOOKS
  const claimed = await claimDue(options.limit ?? 50, new Date())

  const queue = [...claimed]
  const workers = Array.from({ length: Math.min(options.concurrency ?? 10, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const result = await attempt(next, allowPrivate)
      await record(next, result)
    }
  })
  await Promise.all(workers)
  return claimed.length
}
