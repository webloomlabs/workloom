import type { Permission } from '../permissions/statements.ts'
import { safeJsonSchema } from './json-schema.ts'
import { allProcedures } from './registry.ts'
import type { AnyProcedure, ProcedurePermission } from './types.ts'

/**
 * The procedure registry, seen as MCP tools.
 *
 * The third generated view of the registry, after the REST routes and the
 * OpenAPI document. An AI assistant connected to Workloom gets every
 * operation its caller may perform, and a new procedure becomes a tool the
 * moment it is defined: nobody maintains a tool list.
 *
 * Kept free of the MCP SDK so that it is a plain function of the registry,
 * testable like `openapi.ts`. The transport lives in the web app.
 */

export type McpToolAnnotations = {
  title: string
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export type McpTool = {
  name: string
  title: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown }
  annotations: McpToolAnnotations
  /** The procedure this tool runs. Not sent to clients. */
  procedure: string
  /** What the caller must hold. Not sent to clients. */
  permission: ProcedurePermission
}

/** `invoice.send` → `invoice_send`. MCP tool names allow only `[A-Za-z0-9_-]`. */
export function mcpToolName(procedure: string): string {
  return procedure.replace(/\./g, '_')
}

/** Verbs that discard, reverse, or withdraw something. Assistants confirm these with the person first. */
const DESTRUCTIVE = /\.(delete|remove|revoke|cancel|void|archive|decline|withdraw|unallocate|disconnect|adjustBalance)$/

/** Verbs that reach people or systems outside Workloom. */
const OUTWARD = /\.(send|email)$/

/**
 * Whether a procedure is offered as a tool at all, to anyone.
 *
 * File uploads are left out: their input is a `File`, which a JSON tool call
 * cannot carry.
 */
export function isMcpExposed(procedure: AnyProcedure): boolean {
  return procedure.mcp !== false && procedure.http.body !== 'multipart'
}

function toTool(procedure: AnyProcedure): McpTool {
  const { $schema: _ignored, ...schema } = (safeJsonSchema(procedure.input) ?? {}) as Record<string, unknown>
  const readOnly = procedure.readOnly === true
  const destructive = !readOnly && (procedure.http.method === 'DELETE' || DESTRUCTIVE.test(procedure.name))
  const permissionNote = procedure.permission === 'authenticated' ? '' : ` Requires the "${procedure.permission}" permission.`

  return {
    name: mcpToolName(procedure.name),
    title: procedure.summary,
    description: `${procedure.summary}.${permissionNote}`,
    inputSchema: { ...schema, type: 'object' },
    annotations: {
      title: procedure.summary,
      readOnlyHint: readOnly,
      destructiveHint: destructive,
      idempotentHint: readOnly || procedure.http.method === 'DELETE' || procedure.http.method === 'PATCH',
      openWorldHint: OUTWARD.test(procedure.name),
    },
    procedure: procedure.name,
    permission: procedure.permission,
  }
}

/**
 * Cached by registry size. The registry only ever grows by re-registration
 * of the same names, so a change in size is the one signal that matters.
 */
let cache: { size: number; tools: McpTool[]; byName: Map<string, McpTool> } | undefined

function catalogue() {
  const procedures = allProcedures()
  if (cache?.size === procedures.length) return cache
  const tools = procedures
    .filter(isMcpExposed)
    .map(toTool)
    .sort((a, b) => a.name.localeCompare(b.name))
  cache = { size: procedures.length, tools, byName: new Map(tools.map((t) => [t.name, t])) }
  return cache
}

/** Every tool, regardless of who is asking. */
export function mcpTools(): McpTool[] {
  return catalogue().tools
}

/** The tools a caller with these permissions may use. */
export function mcpToolsFor(permissions: ReadonlySet<Permission>): McpTool[] {
  return mcpTools().filter((tool) => isPermitted(tool, permissions))
}

/** Looks a tool up by its MCP name. Undefined for unknown or unexposed names. */
export function mcpToolByName(name: string): McpTool | undefined {
  return catalogue().byName.get(name)
}

export function isPermitted(tool: McpTool, permissions: ReadonlySet<Permission>): boolean {
  return tool.permission === 'authenticated' || permissions.has(tool.permission)
}
