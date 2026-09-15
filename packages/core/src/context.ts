import type { TenantTransaction } from '@workloom/db'
import type { Permission } from './permissions/statements.ts'
import type { Role } from './permissions/roles.ts'
import type { EventType } from './events/catalogue.ts'

/**
 * Who is acting.
 *
 * `apiKey` carries the owning user because a key's authority is derived from
 * theirs and re-evaluated on every request -- never frozen at issue time.
 */
export type Actor =
  | { type: 'user'; id: string; label: string }
  | { type: 'apiKey'; id: string; userId: string; label: string }
  | { type: 'system'; label: string }
  | { type: 'job'; label: string }

export type AuditEntry = {
  action: string
  entityType: string
  entityId?: string | undefined
  entityLabel?: string | undefined
  changes?: Record<string, { from: unknown; to: unknown }> | undefined
}

/**
 * Everything a service needs, and nothing about how the request arrived.
 *
 * This type is why the same business logic serves the web UI, the public REST
 * API, background jobs, and tests: each transport builds a context and calls
 * the service. Services never construct one, and `packages/core` never
 * imports `packages/auth` -- which is what keeps that possible.
 */
export type ActorContext = {
  organizationId: string
  actor: Actor
  /** Null for system and job actors, which are not organization members. */
  role: Role | null
  /**
   * What this actor may actually do: their role's permissions, narrowed by
   * an API key's scopes where one is in play.
   */
  permissions: ReadonlySet<Permission>

  /** The tenant-scoped transaction. Every query in a service runs on it. */
  tx: TenantTransaction

  /** Correlates audit entries, application logs, and the API error envelope. */
  requestId: string
  /** Injected rather than read from the clock, so time-dependent logic is testable. */
  now: Date
  ipAddress?: string | undefined
  userAgent?: string | undefined

  has(permission: Permission): boolean
  /** Throws {@link ForbiddenError} unless the permission is held. */
  require(permission: Permission): void
  /** Records an intent. Written inside `tx`, so it commits with the change. */
  audit(entry: AuditEntry): Promise<void>
  /**
   * Announces a change to webhooks and automations. Written to the outbox
   * inside `tx`: if the change rolls back, so does the event. `data` should be
   * the entity's REST representation, as documented in the OpenAPI spec.
   */
  emit(type: EventType, data: unknown): Promise<string>
  /**
   * Runs once the transaction has committed. For side effects outside the
   * database that must not happen if the change rolls back, such as deleting
   * a stored file. A failure is logged, not thrown: the change already happened.
   */
  afterCommit(fn: () => Promise<void>): void
  /**
   * Runs if the transaction rolls back. For undoing side effects taken before
   * the commit, such as a file already written to storage.
   */
  afterRollback(fn: () => Promise<void>): void
}

/**
 * Error classes that transports recognise must be recognisable from any copy
 * of this module.
 *
 * There can be several copies in one process: Next.js bundles each route and
 * each rendering layer separately, so the procedure that throws a DomainError
 * and the Server Action that catches it may hold different class objects. A
 * plain `instanceof` then fails, and a validation message meant for the person
 * becomes "Something went wrong" -- in production builds only, depending on how
 * chunks happen to be split. Each class brands its instances with a global
 * symbol and answers `instanceof` from the brand.
 */
const KIND = Symbol.for('workloom.error-kind')

function hasKind(value: unknown, kind: string): boolean {
  return typeof value === 'object' && value !== null && (value as { [KIND]?: string })[KIND] === kind
}

export class ForbiddenError extends Error {
  readonly [KIND] = 'forbidden'
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasKind(value, 'forbidden')
  }

  constructor(readonly permission: Permission) {
    super(`Missing permission: ${permission}`)
    this.name = 'ForbiddenError'
  }
}

/**
 * Raised when a resource does not exist *or* belongs to another organization.
 *
 * The two cases are deliberately indistinguishable. Returning 403 for the
 * second would confirm that a given id exists somewhere in the system, which
 * leaks the existence of other tenants' records.
 */
export class NotFoundError extends Error {
  readonly [KIND] = 'not-found'
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasKind(value, 'not-found')
  }

  constructor(entity: string, id?: string) {
    super(id ? `${entity} not found: ${id}` : `${entity} not found`)
    this.name = 'NotFoundError'
  }
}

/**
 * A request that is well-formed but breaks a business rule -- removing the
 * last owner, an expiry date in the past. The message is written for the
 * person who made the request and is shown to them verbatim.
 *
 * Anything thrown as a plain Error is treated as a server fault instead, and
 * its message is withheld from the caller. Choosing this class is the explicit
 * statement that the message is safe and useful to show.
 */
export class DomainError extends Error {
  readonly [KIND] = 'domain'
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasKind(value, 'domain')
  }

  constructor(
    message: string,
    /** Stable machine-readable reason, e.g. `last_owner`. */
    readonly code: string = 'unprocessable',
    /** The input field at fault, when there is one. */
    readonly field?: string,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export class ConflictError extends Error {
  readonly [KIND] = 'conflict'
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasKind(value, 'conflict')
  }

  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}
