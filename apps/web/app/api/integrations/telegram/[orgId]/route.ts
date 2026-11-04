import { receiveTelegramWebhook } from '@workloom/core/modules'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Telegram's updates are small; anything larger is not one. */
const MAX_BYTES = 1024 * 1024

/**
 * Where Telegram delivers an organization's bot updates, in webhook mode.
 *
 * The secret header is the authority: Telegram sends the one it was given
 * when the bot was connected, and only that organization's bot knows it. The
 * update is stored, not acted on -- the worker processes it -- so this
 * answers in milliseconds. It always answers 200: an error would only make
 * Telegram retry something that will never be accepted.
 */
export async function POST(request: Request, ctx: RouteContext<'/api/integrations/telegram/[orgId]'>) {
  const { orgId } = await ctx.params
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BYTES) return new Response(null, { status: 200 })
  let body: unknown = null
  try {
    const text = await request.text()
    if (text.length <= MAX_BYTES) body = JSON.parse(text)
  } catch {
    body = null
  }
  const outcome = await receiveTelegramWebhook(orgId, request.headers.get('x-telegram-bot-api-secret-token'), body)
  if (outcome === 'refused') console.warn(`telegram webhook: refused a call for ${orgId}`)
  return new Response(null, { status: 200 })
}
