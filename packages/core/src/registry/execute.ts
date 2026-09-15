import { withTenant, type TenantTransaction } from '@workloom/db'
import { writeAuditEntry } from '../audit.ts'
import { ForbiddenError, type Actor, type ActorContext, type AuditEntry } from '../context.ts'
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
}

/**
 * Builds an ActorContext bound to a tenant transaction.
 *
 * Exported so that background jobs and tests can construct one directly, with
 * a fabricated actor, without going through HTTP.
 */
export function buildContext(
  request: Omit<ExecutionRequest, 'input'>,
  tx: TenantTransaction,
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

  return withTenant(request.organizationId, async (tx) => {
    const context = buildContext(request, tx)
    const output = await procedure.handler(context, input)
    return procedure.output.parse(output)
  })
}
