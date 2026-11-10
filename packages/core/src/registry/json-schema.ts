import { z } from 'zod'

export type JsonSchemaObject = { properties?: Record<string, unknown>; required?: string[] }

/**
 * A procedure's zod schema as JSON Schema, for the OpenAPI document and the
 * MCP tool list.
 *
 * Some schemas (dates, branded types) have no clean JSON Schema form. A
 * description that is missing one field's shape is far better than no
 * description, so a failure here degrades rather than throws.
 */
export function safeJsonSchema(schema: z.ZodType): JsonSchemaObject | undefined {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaObject
  } catch {
    return undefined
  }
}
