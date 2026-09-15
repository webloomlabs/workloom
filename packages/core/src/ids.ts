import { v7 as uuidv7 } from 'uuid'

/**
 * Identifier generation.
 *
 * UUIDv7 rather than v4. The leading 48 bits are a millisecond timestamp, so
 * ids sort by creation time. That buys two things:
 *
 *   - Insert locality. Random v4 keys scatter writes across the whole B-tree,
 *     splitting pages as a table grows; v7 appends to the right-hand edge.
 *   - Free keyset pagination. `WHERE (organization_id, id) > (?, ?) ORDER BY id`
 *     is a chronological cursor with no extra column and no offset scan.
 *
 * They are also generated in the application rather than the database, which
 * the outbox depends on: an event's id has to be known inside the transaction
 * that writes it.
 *
 * Node has no native v7 -- `crypto.randomUUID({ version: 7 })` silently
 * returns a v4 -- so this comes from the `uuid` package.
 */
export function newId(): string {
  return uuidv7()
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}
