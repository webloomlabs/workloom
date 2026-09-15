import 'server-only'
import { EVENT_CATALOGUE } from '@workloom/core'
import type { EventFamily } from '@/components/webhook-forms'

/** The event catalogue grouped for the subscription picker. */
export function eventFamilies(): EventFamily[] {
  const byFamily = new Map<string, EventFamily>()
  for (const event of EVENT_CATALOGUE) {
    const family = event.type.split('.')[0]!
    if (!byFamily.has(family)) byFamily.set(family, { family, types: [] })
    byFamily.get(family)!.types.push({ type: event.type, description: event.description, emitted: event.emitted })
  }
  return [...byFamily.values()]
}
