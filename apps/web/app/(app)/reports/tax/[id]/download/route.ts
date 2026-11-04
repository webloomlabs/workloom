import { taxPackDownload } from '@workloom/core/modules'
import { call } from '@/lib/server/procedures'

export const dynamic = 'force-dynamic'

/** Sends the browser to a short-lived link for a ready pack. The procedure checks the permission. */
export async function GET(_request: Request, ctx: RouteContext<'/reports/tax/[id]/download'>) {
  const { id } = await ctx.params
  const { url } = await call(taxPackDownload, { id })
  return new Response(null, { status: 303, headers: { location: url, 'cache-control': 'private, no-store' } })
}
