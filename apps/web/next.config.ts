import type { NextConfig } from 'next'

/**
 * Sent on every response.
 *
 * `script-src` still allows inline scripts, because Next hydrates through them
 * and a nonce-based policy needs middleware on every request; what the policy
 * buys today is that no script, style, frame, or object may come from anywhere
 * but this origin. Tightening it is worth doing, and is not worth pretending
 * has been done.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Nothing here is meant to be embedded, including a client's invoice page.
  "frame-ancestors 'none'",
].join('; ')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  // Only where there is TLS to insist on. Sent on an http:// installation it
  // would be ignored today and could lock the host out of http tomorrow.
  ...(process.env.APP_URL?.startsWith('https://')
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
]

const config: NextConfig = {
  // The version of the framework is not the operator's secret to keep, but it
  // is free reconnaissance and costs nothing to withhold.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
  // Workspace packages ship TypeScript source rather than a build artifact,
  // so there is no build step in the dev loop. Next compiles them itself.
  transpilePackages: [
    '@workloom/config',
    '@workloom/db',
    '@workloom/storage',
    '@workloom/core',
    '@workloom/auth',
    '@workloom/emails',
    '@workloom/ui',
  ],
  // A self-contained server plus only the files it traced, which is what the
  // container copies. Without it the image would need the whole workspace and
  // its node_modules.
  output: 'standalone',
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  // The Postgres driver is native and must not be bundled.
  serverExternalPackages: ['pg', 'nodemailer'],
  experimental: {
    serverActions: {
      // Attachments are up to 20 MB (ATTACHMENT_MAX_BYTES), plus multipart overhead.
      bodySizeLimit: '21mb',
    },
  },
}

export default config
