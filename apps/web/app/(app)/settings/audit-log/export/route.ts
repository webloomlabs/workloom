import { auditLogExport } from '@workloom/core/modules'
import { call } from '@/lib/server/procedures'

export const dynamic = 'force-dynamic'

const SOURCES = ['web', 'api', 'telegram', 'worker', 'system'] as const
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The audit log as CSV, with the filters on the page. The procedure checks the permission. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const text = (name: string) => params.get(name)?.trim() ?? ''
  const source = text('source') as (typeof SOURCES)[number]
  const exported = await call(auditLogExport, {
    ...(text('action') ? { action: text('action').slice(0, 64) } : {}),
    ...(SOURCES.includes(source) ? { source } : {}),
    ...(DAY.test(text('from')) ? { from: text('from') } : {}),
    ...(DAY.test(text('to')) ? { to: text('to') } : {}),
  })
  return new Response(exported.csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exported.filename}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
