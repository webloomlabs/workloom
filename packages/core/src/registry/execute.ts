import { createHash } from 'node:crypto'
import { sql, withTenant, type TenantTransaction } from '@workloom/db'
import { writeAuditEntry } from '../audit.ts'
import { writeEvent } from '../events/emit.ts'
import {
  DomainError,
  ForbiddenError,
  type Actor,
  type ActorContext,
  type AuditEntry,
} from '../context.ts'
import { newId } from '../ids.ts'
import type { Permission } from '../permissions/statements.ts'
import type { Role } from '../permissions/roles.ts'
import { getProcedure } from './registry.ts'

export type ExecutionRequest = {
  organizationId: string
  actor: Actor
  role: Role | null
  permissions: ReadonlySet<Permission>
  input: unknown
  requestId?: string
  now?: Date
  ipAddress?: string | undefined
  userAgent?: string | undefined
  /**
   * From the `Idempotency-Key` header. Ignored for reads. A repeated key with
   * the same input returns the original response without running the handler
   * again; with different input it is refused.
   */
  idempotencyKey?: string | undefined
  /** Called when the response is a replay rather than a fresh execution. */
  onReplay?: (() => void) | undefined
}

/** Keys sorted at every level, so `{a, b}` and `{b, a}` hash identically. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    // A file serialises to {} and would make every upload look identical.
    typeof Blob !== 'undefined' && v instanceof Blob
      ? { file: (v as File).name ?? null, size: v.size, type: v.type }
      : v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  )
}

function actorKey(actor: Actor): string {
  if (actor.type === 'apiKey') return `api_key:${actor.id}`
  if (actor.type === 'user') return `user:${actor.id}`
  return actor.type
}

/**
 * Builds an ActorContext bound to a tenant transaction.
 *
 * Exported so that background jobs and tests can construct one directly, with
 * a fabricated actor, without going through HTTP.
 */
export type TransactionHooks = { commit: Array<() => Promise<void>>; rollback: Array<() => Promise<void>> }

export function buildContext(
  request: Omit<ExecutionRequest, 'input'>,
  tx: TenantTransaction,
  /** Collected here and run by the caller once the transaction settles. */
  hooks: TransactionHooks = { commit: [], rollback: [] },
): ActorContext {
  const requestId = request.requestId ?? newId()
  const context: ActorContext = {
    organizationId: request.organizationId,
    actor: request.actor,
    role: request.role,
    permissions: request.permissions,
    tx,
    requestId,
    now: request.now ?? new Date(),
    ipAddress: request.ipAddress,
    userAgent: request.userAgent,

    has: (permission) => request.permissions.has(permission),
    require: (permission) => {
      if (!request.permissions.has(permission)) throw new ForbiddenError(permission)
    },
    audit: (entry: AuditEntry) =>
      writeAuditEntry(tx, {
        organizationId: request.organizationId,
        actor: request.actor,
        requestId,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        entry,
      }),
    emit: (type, data) =>
      writeEvent(tx, { organizationId: request.organizationId, actor: request.actor, type, data }),
    afterCommit: (fn) => void hooks.commit.push(fn),
    afterRollback: (fn) => void hooks.rollback.push(fn),
  }
  return context
}

/**
 * Runs one procedure.
 *
 * Order matters. Permission is checked before the input is even parsed, so a
 * caller who may not perform an operation learns nothing from its validation
 * messages about the shape of data they cannot reach.
 *
 * The handler runs inside a single tenant transaction, which means the change
 * and its audit entry commit together or not at all.
 */
export async function executeProcedure(name: string, request: ExecutionRequest): Promise<unknown> {
  const procedure = getProcedure(name)
  if (!procedure) throw new Error(`Unknown procedure: ${name}`)

  if (procedure.permission !== 'authenticated' && !request.permissions.has(procedure.permission)) {
    throw new ForbiddenError(procedure.permission)
  }

  const input = procedure.input.parse(request.input)
  const key = procedure.readOnly ? undefined : request.idempotencyKey

  if (key !== undefined && !/^[\x21-\x7e]{1,255}$/.test(key)) {
    throw new DomainError(
      'Idempotency-Key must be 1-255 printable ASCII characters, such as a UUID.',
      'invalid_idempotency_key',
    )
  }

  const hooks: TransactionHooks = { commit: [], rollback: [] }
  let output: unknown
  try {
    output = await runInTransaction(procedure, request, input, key, hooks)
  } catch (error) {
    await runHooks(hooks.rollback, `${procedure.name} rollback`)
    throw error
  }
  await runHooks(hooks.commit, `${procedure.name} commit`)
  return output
}

/** Hooks run in order; one failing does not stop the rest. */
async function runHooks(fns: Array<() => Promise<void>>, label: string): Promise<void> {
  for (const fn of fns) {
    try {
      await fn()
    } catch (error) {
      console.error(`[hooks] ${label} hook failed`, error)
    }
  }
}

async function runInTransaction(
  procedure: NonNullable<ReturnType<typeof getProcedure>>,
  request: ExecutionRequest,
  input: unknown,
  key: string | undefined,
  hooks: TransactionHooks,
): Promise<unknown> {
  return withTenant(request.organizationId, async (tx) => {
    if (key !== undefined) {
      const requestHash = createHash('sha256')
        .update(`${procedure.name}\n${canonicalJson(input)}`)
        .digest('hex')

      /**
       * Claim the key inside the same transaction as the mutation.
       *
       * A concurrent request with the same key blocks on this insert until the
       * first transaction finishes. If the first committed, the insert is a
       * no-op and the stored response is replayed. If it rolled back, the key
       * was never recorded and this request simply proceeds. Either way the
       * operation runs at most once -- with no "in progress" state to expire.
       */
      const claimed = await tx.execute(sql`
        insert into idempotency_keys (organization_id, actor_key, key, procedure, request_hash, response)
        values (${request.organizationId}::uuid, ${actorKey(request.actor)}, ${key},
                ${procedure.name}, ${requestHash}, 'null'::jsonb)
        on conflict do nothing
        returning 1
      `)

      if (claimed.rows.length === 0) {
        const { rows } = await tx.execute<{ procedure: string; request_hash: string; response: unknown }>(sql`
          select procedure, request_hash, response from idempotency_keys
          where organization_id = ${request.organizationId}::uuid
            and actor_key = ${actorKey(request.actor)} and key = ${key}
        `)
        const existing = rows[0]!
        if (existing.procedure !== procedure.name || existing.request_hash !== requestHash) {
          throw new DomainError(
            'This Idempotency-Key was already used for a different request. Use a new key for a new operation.',
            'idempotency_key_reused',
          )
        }
        request.onReplay?.()
        return existing.response
      }
    }

    const context = buildContext(request, tx, hooks)
    const output = procedure.output.parse(await procedure.handler(context, input))

    if (key !== undefined) {
      // Stored as the wire form (dates as ISO strings), which is what a replay
      // must return.
      await tx.execute(sql`
        update idempotency_keys set response = ${JSON.stringify(output)}::jsonb
        where organization_id = ${request.organizationId}::uuid
          and actor_key = ${actorKey(request.actor)} and key = ${key}
      `)
    }
    return output
  })
}
