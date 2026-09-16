import { readPdfToken, renderInvoicePdf } from '@workloom/core/modules'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Renders a document PDF for a signed link.
 *
 * The link is the authority here: it was issued to someone who had just proved
 * they may read the invoice, it expires, and it names its own organization, so
 * the read still happens inside that tenant's transaction. The response is
 * always an attachment, never inline, and is never cached by a shared proxy.
 */
export async function GET(_request: Request, ctx: RouteContext<'/api/documents/[token]'>) {
  const { token } = await ctx.params
  const link = readPdfToken(token)
  if (!link) return new Response('This link has expired.', { status: 403 })

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
