import { readDocumentToken, renderInvoicePdf } from '@workloom/core/modules'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The PDF behind a client's link. The same authority as the page -- the signed
 * link, which does not expire, because a client must be able to fetch their
 * invoice whenever they need it.
 */
export async function GET(_request: Request, ctx: RouteContext<'/i/[token]/pdf'>) {
  const { token } = await ctx.params
  const link = readDocumentToken(token)
  if (!link) return new Response('Not found.', { status: 404 })

  const document = await renderInvoicePdf(link.organizationId, link.documentId)
  if (!document) return new Response('Not found.', { status: 404 })

  return new Response(new Uint8Array(document.bytes), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${document.filename}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
