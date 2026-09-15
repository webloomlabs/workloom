import { attachmentDisposition, LocalStorage, storage } from '@workloom/storage'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Serves files from local-disk storage against a signed URL.
 *
 * The signature is the authorisation: it was issued moments ago by
 * `attachment.download`, after that procedure checked the caller could read
 * the file, and it binds the storage key, expiry, download name, and content
 * type together. With S3 storage the browser goes straight to the bucket and
 * this route is never used.
 *
 * Every response is a download. Served inline from this origin, an uploaded
 * HTML or SVG file would run its scripts as whoever opened it.
 */
export async function GET(request: Request) {
  const signed = LocalStorage.verify(new URL(request.url).searchParams)
  if (!signed) return new Response('This link is invalid or has expired.', { status: 403 })

  let body: Buffer
  try {
    body = await storage().get(signed.key)
  } catch {
    return new Response('Not found.', { status: 404 })
  }

  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': signed.type,
      'content-disposition': attachmentDisposition(signed.name),
      'content-length': String(body.byteLength),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  })
}
