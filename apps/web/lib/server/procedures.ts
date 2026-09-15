import 'server-only'
import { executeProcedure } from '@workloom/core/registry'
import '@workloom/core/modules'
import { headers } from 'next/headers'
import type { z } from 'zod'
import { requireViewer } from './viewer.ts'

type Callable = { name: string; input: z.ZodType; output: z.ZodType }

/**
 * Calls a procedure as the current viewer.
 *
 * Pages and Server Actions use this and nothing else to read or change data.
 * It is the same entry point the REST API uses, so anything the UI can do is
 * also available -- and audited -- through the API.
 */
export async function call<P extends Callable>(
  procedure: P,
  input: z.input<P['input']>,
): Promise<z.output<P['output']>> {
  const viewer = await requireViewer()
  const requestHeaders = await headers()

  return (await executeProcedure(procedure.name, {
    organizationId: viewer.organizationId,
    actor: viewer.actor,
    role: viewer.role as never,
    permissions: viewer.permissions,
    input,
    ipAddress: requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
    userAgent: requestHeaders.get('user-agent') ?? undefined,
  })) as z.output<P['output']>
}
