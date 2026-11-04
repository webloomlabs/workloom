import { organizationLogoGet } from '@workloom/core/modules'
import { call } from '@/lib/server/procedures'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The organization's printed logo, for its own settings page to preview.
 *
 * Read through a procedure as the signed-in viewer, and served as the type its
 * bytes were checked to be -- never as whatever was claimed at upload.
 */
export async function GET() {
  const { logo } = await call(organizationLogoGet, {})
  if (!logo) return new Response('Not found.', { status: 404 })
  return new Response(new Uint8Array(Buffer.from(logo.base64, 'base64')), {
    headers: {
      'content-type': logo.contentType,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  })
}
