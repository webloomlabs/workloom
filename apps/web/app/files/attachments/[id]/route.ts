import { attachmentDownload } from '@workloom/core/modules'
import { NotFoundError } from '@workloom/core'
import { call } from '@/lib/server/procedures'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The link the interface uses for a file. It asks for a fresh short-lived URL
 * as the signed-in viewer -- so the permission check happens now, not when the
 * page was rendered -- and sends the browser there.
 */
export async function GET(_request: Request, ctx: RouteContext<'/files/attachments/[id]'>) {
  const { id } = await ctx.params
  try {
    const { url } = await call(attachmentDownload, { id })
    return Response.redirect(url, 302)
  } catch (error) {
    if (error instanceof NotFoundError) return new Response('Not found.', { status: 404 })
    throw error
  }
}
