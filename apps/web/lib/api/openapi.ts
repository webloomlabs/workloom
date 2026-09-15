import { allProcedures, type AnyProcedure } from '@workloom/core/registry'
import { z } from 'zod'

/**
 * Generates the OpenAPI document from the registry.
 *
 * Derived rather than hand-maintained, and from the very same zod schemas the
 * services validate against -- so the document cannot describe an API that
 * does not exist, and cannot omit one that does.
 *
 * Zod 4 emits JSON Schema natively, so this needs no additional dependency.
 */
export function buildOpenApiDocument(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const procedure of allProcedures()) {
    const path = procedure.http.path
    const method = procedure.http.method.toLowerCase()
    paths[path] ??= {}
    paths[path][method] = operationFor(procedure)
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Workloom API',
      version: '0.1.0',
      description:
        'The operational API for a Workloom installation. Every operation the ' +
        'application performs is available here; the user interface uses the same ' +
        'service layer.',
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An API key, sent as `Authorization: Bearer wl_live_...`. A key can never ' +
            'exceed the permissions of the user who owns it, evaluated per request.',
        },
      },
    },
    paths,
  }
}

function operationFor(procedure: AnyProcedure) {
  const pathParams = [...procedure.http.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)
  const inputSchema = safeJsonSchema(procedure.input)
  const properties = (inputSchema?.properties ?? {}) as Record<string, unknown>

  type Parameter = { name: string; in: string; required: boolean; schema: unknown }
  const parameters: Parameter[] = pathParams.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: properties[name] ?? { type: 'string' },
  }))

  // On a GET the remaining input fields arrive as query parameters; on a
  // mutation they are the request body.
  if (procedure.http.method === 'GET') {
    for (const [name, schema] of Object.entries(properties)) {
      if (pathParams.includes(name)) continue
      parameters.push({
        name,
        in: 'query',
        required: (inputSchema?.required ?? []).includes(name),
        schema,
      })
    }
  }

  const bodyProperties = Object.fromEntries(
    Object.entries(properties).filter(([name]) => !pathParams.includes(name)),
  )

  return {
    operationId: procedure.name,
    summary: procedure.summary,
    tags: [procedure.name.split('.')[0]],
    parameters,
    ...(procedure.http.method === 'GET' || Object.keys(bodyProperties).length === 0
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: bodyProperties },
              },
            },
          },
        }),
    responses: {
      [String(procedure.http.successStatus ?? (procedure.readOnly ? 200 : 200))]: {
        description: 'Success',
        content: { 'application/json': { schema: safeJsonSchema(procedure.output) ?? {} } },
      },
      '403': { description: 'The actor lacks the required permission' },
      '404': { description: 'No such resource in this organization' },
      '422': { description: 'The request failed validation' },
      '429': { description: 'Rate limit exceeded' },
    },
  }
}

type JsonSchemaObject = { properties?: Record<string, unknown>; required?: string[] }

/**
 * Some schemas (dates, branded types) have no clean JSON Schema form. A
 * document that is missing one field's shape is far better than no document,
 * so a failure here degrades rather than throws.
 */
function safeJsonSchema(schema: z.ZodType): JsonSchemaObject | undefined {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaObject
  } catch {
    return undefined
  }
}
