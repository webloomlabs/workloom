import { schema, type TenantTransaction } from '@workloom/db'
import type { Actor } from '../context.ts'
import { newId } from '../ids.ts'
import type { EventType } from './catalogue.ts'

/**
 * Writes an event into the outbox, inside the caller's transaction.
 *
 * This is the only way an event comes into existence. Because it shares the
 * transaction of the change it describes, the two commit or roll back
 * together.
 */
export async function writeEvent(
  tx: TenantTransaction,
  options: { organizationId: string; actor: Actor; type: EventType; data: unknown },
): Promise<string> {
  const id = newId()
  await tx.insert(schema.events).values({
    id,
    organizationId: options.organizationId,
    type: options.type,
    actor: {
      type: options.actor.type === 'apiKey' ? 'api_key' : options.actor.type,
      id: 'id' in options.actor ? options.actor.id : null,
      label: options.actor.label,
    },
    // Round-tripped through JSON so the stored payload is exactly what a
    // webhook consumer will receive: dates as ISO strings, no undefineds.
    data: JSON.parse(JSON.stringify(options.data ?? {})),
  })
  return id
}
