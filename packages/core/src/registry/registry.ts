import type { z } from 'zod'
import type { AnyProcedure, ProcedureDefinition } from './types.ts'

/**
 * The procedure registry.
 *
 * Every operation is declared once, here, and from that single declaration
 * come: input validation, the permission check, the tenant transaction, the
 * audit write, the REST route, the OpenAPI path, and the Server Action
 * binding.
 *
 * The alternative -- wiring each of those separately per feature -- is where
 * a UI and its API drift apart. This makes the drift impossible rather than
 * merely discouraged.
 */
/**
 * Held on globalThis so that every copy of this module in the process shares
 * one registry.
 *
 * There can be several copies. Next.js bundles each route separately, so a
 * production server evaluates the procedure modules once per bundle; the dev
 * server re-evaluates them on every edit. Each evaluation re-registers the same
 * procedures, and a later registration simply replaces an earlier one.
 *
 * Genuine duplicates -- two different procedures claiming one name or one
 * route -- are caught where they can be caught reliably: the registry unit
 * test, in CI. A runtime check cannot tell a duplicate from a re-evaluation,
 * and an earlier version that threw on repeats took down every settings page
 * in production while passing every test and the dev server.
 */
const REGISTRY_KEY = Symbol.for('workloom.procedure-registry')

const globalRegistry = globalThis as typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, AnyProcedure>
}

const procedures: Map<string, AnyProcedure> = (globalRegistry[REGISTRY_KEY] ??= new Map())

export function defineProcedure<TInput extends z.ZodType, TOutput extends z.ZodType>(
  definition: ProcedureDefinition<TInput, TOutput>,
): ProcedureDefinition<TInput, TOutput> {
  procedures.set(definition.name, definition as unknown as AnyProcedure)
  return definition
}

export function getProcedure(name: string): AnyProcedure | undefined {
  return procedures.get(name)
}

export function allProcedures(): AnyProcedure[] {
  return [...procedures.values()]
}

/** Test seam. Never call from application code. */
export function resetRegistry(): void {
  procedures.clear()
}
