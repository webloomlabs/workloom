import { env } from '@workloom/config'
import { and, desc, eq, lt, schema } from '@workloom/db'
import { z } from 'zod'
import { DomainError, NotFoundError, type ActorContext } from '../context.ts'
import { encryptSecret } from '../crypto.ts'
import { EVENT_TYPES, isValidPattern } from '../events/catalogue.ts'
import { newId } from '../ids.ts'
import { defineProcedure } from '../registry/index.ts'
import {
  assertResolvesPublicly,
  generateWebhookSecret,
  parseWebhookUrl,
  UnsafeWebhookUrlError,
} from '../webhooks/index.ts'

/** How long the old secret keeps signing deliveries after a rotation. */
const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000

const endpointOutput = z.object({
  id: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(z.string()),
  enabled: z.boolean(),
  disabledReason: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  /** True while a rotated-out secret is still signing deliveries. */
  rotating: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

type EndpointRow = typeof schema.webhookEndpoints.$inferSelect

function present(row: EndpointRow, now: Date): z.input<typeof endpointOutput> {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.eventTypes,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    consecutiveFailures: row.consecutiveFailures,
    rotating: row.previousSecretExpiresAt !== null && row.previousSecretExpiresAt > now,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // The secret is never part of the representation, encrypted or not.
  }
}

const eventTypesInput = z
  .array(z.string())
  .min(1, 'Subscribe to at least one event, or "*" for all of them.')
  .refine((patterns) => patterns.every(isValidPattern), {
    message: `Unknown event type. Use a type such as "invoice.paid", a family such as "invoice.*", or "*".`,
  })
  .transform((patterns) => [...new Set(patterns)].sort())

async function validateUrl(raw: string): Promise<string> {
  const allowPrivate = env.WORKLOOM_ALLOW_PRIVATE_WEBHOOKS
  try {
    const url = parseWebhookUrl(raw, { allowPrivate })
    if (!allowPrivate) await assertResolvesPublicly(url)
    return url.toString()
  } catch (error) {
    if (error instanceof UnsafeWebhookUrlError) throw new DomainError(error.message, 'unsafe_url', 'url')
    throw error
  }
}

async function loadEndpoint(ctx: ActorContext, id: string): Promise<EndpointRow> {
  const [row] = await ctx.tx
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, id))
    .limit(1)
  // Row-level security has already scoped this to the organization, so a
  // missing row reads the same whether it never existed or is someone else's.
  if (!row) throw new NotFoundError('Webhook endpoint', id)
  return row
}

export const webhookList = defineProcedure({
  name: 'webhook.list',
  summary: 'Webhook endpoints in this organization',
  permission: 'webhook:read',
  readOnly: true,
  input: z.object({}),
  output: z.object({ data: z.array(endpointOutput) }),
  http: { method: 'GET', path: '/webhooks' },
  async handler(ctx) {
    const rows = await ctx.tx
      .select()
      .from(schema.webhookEndpoints)
      .orderBy(desc(schema.webhookEndpoints.createdAt))
    return { data: rows.map((r) => present(r, ctx.now)) }
  },
})

export const webhookGet = defineProcedure({
  name: 'webhook.get',
  summary: 'One webhook endpoint',
  permission: 'webhook:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: endpointOutput,
  http: { method: 'GET', path: '/webhooks/{id}' },
  async handler(ctx, input) {
    return present(await loadEndpoint(ctx, input.id), ctx.now)
  },
})

export const webhookEventTypes = defineProcedure({
  name: 'webhook.eventTypes',
  summary: 'Every event type a webhook can subscribe to',
  permission: 'webhook:read',
  readOnly: true,
  input: z.object({}),
  output: z.object({ data: z.array(z.string()) }),
  // Not /webhooks/event-types: that would be captured by /webhooks/{id}.
  http: { method: 'GET', path: '/webhook-event-types' },
  async handler() {
    return { data: [...EVENT_TYPES] }
  },
})

export const webhookCreate = defineProcedure({
  name: 'webhook.create',
  summary: 'Register a webhook endpoint',
  permission: 'webhook:create',
  input: z.object({
    url: z.string().min(1).max(2048),
    description: z.string().max(200).nullish(),
    eventTypes: eventTypesInput,
  }),
  output: z.object({
    endpoint: endpointOutput,
    /**
     * Shown once. Unlike an API key it is stored -- encrypted, because signing
     * needs it -- but no endpoint ever returns it again. Rotate to get a new one.
     */
    secret: z.string(),
  }),
  http: { method: 'POST', path: '/webhooks', successStatus: 201 },
  emits: [],
  async handler(ctx, input) {
    const url = await validateUrl(input.url)
    const secret = generateWebhookSecret()

    const [row] = await ctx.tx
      .insert(schema.webhookEndpoints)
      .values({
        id: newId(),
        organizationId: ctx.organizationId,
        url,
        description: input.description ?? null,
        eventTypes: input.eventTypes,
        secretEncrypted: encryptSecret(secret),
        createdBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
      })
      .returning()

    await ctx.audit({
      action: 'webhook.created',
      entityType: 'webhook_endpoint',
      entityId: row!.id,
      entityLabel: url,
      changes: { eventTypes: { from: null, to: input.eventTypes } },
    })

    return { endpoint: present(row!, ctx.now), secret }
  },
})

export const webhookUpdate = defineProcedure({
  name: 'webhook.update',
  summary: 'Change a webhook endpoint',
  permission: 'webhook:update',
  input: z.object({
    id: z.uuid(),
    url: z.string().min(1).max(2048).optional(),
    description: z.string().max(200).nullish(),
    eventTypes: eventTypesInput.optional(),
    enabled: z.boolean().optional(),
  }),
  output: endpointOutput,
  http: { method: 'PATCH', path: '/webhooks/{id}' },
  emits: [],
  async handler(ctx, input) {
    const before = await loadEndpoint(ctx, input.id)
    const patch: Partial<EndpointRow> = { updatedAt: ctx.now }

    if (input.url !== undefined && input.url !== before.url) patch.url = await validateUrl(input.url)
    if (input.description !== undefined) patch.description = input.description ?? null
    if (input.eventTypes !== undefined) patch.eventTypes = input.eventTypes
    if (input.enabled !== undefined) {
      patch.enabled = input.enabled
      if (input.enabled) {
        // Re-enabling is a statement that the receiver is fixed: start the
        // failure count again rather than tripping off at the next hiccup.
        patch.disabledReason = null
        patch.consecutiveFailures = 0
      }
    }

    const [after] = await ctx.tx
      .update(schema.webhookEndpoints)
      .set(patch)
      .where(eq(schema.webhookEndpoints.id, before.id))
      .returning()

    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const field of ['url', 'description', 'eventTypes', 'enabled'] as const) {
      if (JSON.stringify(before[field]) !== JSON.stringify(after![field])) {
        changes[field] = { from: before[field], to: after![field] }
      }
    }
    await ctx.audit({
      action: 'webhook.updated',
      entityType: 'webhook_endpoint',
      entityId: before.id,
      entityLabel: after!.url,
      changes,
    })

    return present(after!, ctx.now)
  },
})

export const webhookDelete = defineProcedure({
  name: 'webhook.delete',
  summary: 'Delete a webhook endpoint and its delivery history',
  permission: 'webhook:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/webhooks/{id}' },
  emits: [],
  async handler(ctx, input) {
    const endpoint = await loadEndpoint(ctx, input.id)
    await ctx.tx.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpoint.id))
    await ctx.audit({
      action: 'webhook.deleted',
      entityType: 'webhook_endpoint',
      entityId: endpoint.id,
      entityLabel: endpoint.url,
    })
    return { deleted: true }
  },
})

export const webhookRotateSecret = defineProcedure({
  name: 'webhook.rotateSecret',
  summary: 'Issue a new signing secret, keeping the old one valid for 24 hours',
  permission: 'webhook:update',
  input: z.object({ id: z.uuid() }),
  output: z.object({ endpoint: endpointOutput, secret: z.string(), previousSecretExpiresAt: z.date() }),
  http: { method: 'POST', path: '/webhooks/{id}/rotate-secret' },
  emits: [],
  async handler(ctx, input) {
    const endpoint = await loadEndpoint(ctx, input.id)
    const secret = generateWebhookSecret()
    const previousSecretExpiresAt = new Date(ctx.now.getTime() + ROTATION_OVERLAP_MS)

    // For the overlap window every delivery is signed with both secrets, so a
    // receiver can deploy the new one whenever it likes without missing events.
    const [after] = await ctx.tx
      .update(schema.webhookEndpoints)
      .set({
        secretEncrypted: encryptSecret(secret),
        previousSecretEncrypted: endpoint.secretEncrypted,
        previousSecretExpiresAt,
        updatedAt: ctx.now,
      })
      .where(eq(schema.webhookEndpoints.id, endpoint.id))
      .returning()

    await ctx.audit({
      action: 'webhook.secret_rotated',
      entityType: 'webhook_endpoint',
      entityId: endpoint.id,
      entityLabel: endpoint.url,
    })

    return { endpoint: present(after!, ctx.now), secret, previousSecretExpiresAt }
  },
})

export const webhookTest = defineProcedure({
  name: 'webhook.test',
  summary: 'Send a test event to one endpoint',
  permission: 'webhook:update',
  input: z.object({ id: z.uuid() }),
  output: z.object({ eventId: z.uuid() }),
  http: { method: 'POST', path: '/webhooks/{id}/test', successStatus: 202 },
  emits: ['webhook.test'],
  async handler(ctx, input) {
    const endpoint = await loadEndpoint(ctx, input.id)
    // Routed by the dispatcher to this endpoint alone, whatever it subscribes
    // to -- including while it is disabled, which is when a test is most useful.
    const eventId = await ctx.emit('webhook.test', {
      endpointId: endpoint.id,
      message: 'This is a test event from Workloom.',
    })
    await ctx.audit({
      action: 'webhook.tested',
      entityType: 'webhook_endpoint',
      entityId: endpoint.id,
      entityLabel: endpoint.url,
    })
    return { eventId }
  },
})

const deliveryOutput = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  eventType: z.string(),
  status: z.enum(['pending', 'succeeded', 'failed']),
  attempts: z.number().int(),
  nextAttemptAt: z.date().nullable(),
  lastAttemptAt: z.date().nullable(),
  responseStatus: z.number().int().nullable(),
  responseBody: z.string().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
})

export const webhookDeliveryList = defineProcedure({
  name: 'webhookDelivery.list',
  summary: 'Recent deliveries to one endpoint, newest first',
  permission: 'webhook:read',
  readOnly: true,
  input: z.object({
    id: z.uuid(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.uuid().optional(),
  }),
  output: z.object({ data: z.array(deliveryOutput), nextCursor: z.uuid().nullable() }),
  http: { method: 'GET', path: '/webhooks/{id}/deliveries' },
  async handler(ctx, input) {
    await loadEndpoint(ctx, input.id)
    const rows = await ctx.tx
      .select()
      .from(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.endpointId, input.id),
          input.cursor ? lt(schema.webhookDeliveries.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(schema.webhookDeliveries.id))
      .limit(input.limit + 1)

    const hasMore = rows.length > input.limit
    const data = (hasMore ? rows.slice(0, input.limit) : rows).map((r) => ({
      ...r,
      status: r.status as 'pending' | 'succeeded' | 'failed',
    }))
    return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null }
  },
})

export const webhookDeliveryRetry = defineProcedure({
  name: 'webhookDelivery.retry',
  summary: 'Queue a failed delivery to be attempted again now',
  permission: 'webhook:update',
  input: z.object({ id: z.uuid() }),
  output: deliveryOutput,
  http: { method: 'POST', path: '/webhook-deliveries/{id}/retry', successStatus: 202 },
  emits: [],
  async handler(ctx, input) {
    const [delivery] = await ctx.tx
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, input.id))
      .limit(1)
    if (!delivery) throw new NotFoundError('Delivery', input.id)
    if (delivery.status !== 'failed') {
      throw new DomainError('Only failed deliveries can be retried.', 'not_failed')
    }

    // A full fresh schedule, since the person pressing retry has presumably
    // just fixed the receiver.
    const [after] = await ctx.tx
      .update(schema.webhookDeliveries)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: ctx.now, completedAt: null, lockedUntil: null })
      .where(eq(schema.webhookDeliveries.id, delivery.id))
      .returning()

    await ctx.audit({
      action: 'webhook.delivery_retried',
      entityType: 'webhook_delivery',
      entityId: delivery.id,
      entityLabel: delivery.eventType,
    })
    return { ...after!, status: 'pending' as const }
  },
})
