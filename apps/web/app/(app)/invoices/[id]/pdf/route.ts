import { invoiceDownload } from '@workloom/core/modules'
import { NotFoundError } from '@workloom/core'
import { call } from '@/lib/server/procedures'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The Download PDF link. It asks for a fresh short-lived URL as the signed-in
 * viewer -- so the permission check happens now -- and sends the browser there,
 * exactly as a stored file's link does.
 */
export async function GET(_request: Request, ctx: RouteContext<'/invoices/[id]/pdf'>) {
  const { id } = await ctx.params
  try {
    const { url } = await call(invoiceDownload, { id })
    return Response.redirect(url, 302)
  } catch (error) {
    if (error instanceof NotFoundError) return new Response('Not found.', { status: 404 })
    throw error
  }
}
