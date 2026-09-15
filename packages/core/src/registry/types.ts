import type { z } from 'zod'
import type { ActorContext } from '../context.ts'
import type { Permission } from '../permissions/statements.ts'

/**
 * How expensive an operation is, for rate limiting. Kept coarse on purpose --
 * per-endpoint limits are a tuning knob nobody has the information to set
 * correctly at this stage.
 */
export type RateLimitClass = 'read' | 'write' | 'expensive'

export type HttpBinding = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** OpenAPI-style path, e.g. `/invoices/{id}/send`. */
  path: string
  /** Overrides the default (200 for GET, 201 for creating POSTs). */
  successStatus?: number
}

/**
 * What a caller must hold to invoke a procedure.
 *
 * `'authenticated'` means any actor with a valid identity in this
 * organization. Reserve it for operations that only report what the caller
 * already is -- gating those behind a permission makes a narrowly scoped API
 * key unable to discover its own scope, which is the one thing every
 * integrator needs first.
 */
export type ProcedurePermission = Permission | 'authenticated'

export type ProcedureDefinition<TInput extends z.ZodType, TOutput extends z.ZodType> = {
  /** Stable dotted name, e.g. `invoice.send`. Used in logs and audit entries. */
  name: string
  summary: string
  permission: ProcedurePermission
  input: TInput
  output: TOutput
  /**
   * Required for every mutation. A procedure with no HTTP binding is one the
   * public API cannot reach, which is how a feature ends up existing only in
   * the UI -- and therefore outside automation and outside the audit trail.
   */
  http: HttpBinding
  rateLimit?: RateLimitClass
  /** True for reads. Used to pick the default rate-limit class and status. */
  readOnly?: boolean
  handler: (ctx: ActorContext, input: z.output<TInput>) => Promise<z.input<TOutput>>
}

export type AnyProcedure = ProcedureDefinition<z.ZodType, z.ZodType>
