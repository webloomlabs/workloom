import { quoteDownload } from '@workloom/core/modules'
import { NotFoundError } from '@workloom/core'
import { call } from '@/lib/server/procedures'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The quote's Download PDF link: a fresh short-lived URL, asked for as the
 * signed-in viewer so the permission check happens now.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const { url } = await call(quoteDownload, { id })
    return Response.redirect(url, 302)
  } catch (error) {
    if (error instanceof NotFoundError) return new Response('Not found.', { status: 404 })
    throw error
  }
}
