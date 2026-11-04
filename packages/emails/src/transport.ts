import { env } from '@workloom/config'
import nodemailer, { type Transporter } from 'nodemailer'

let transporter: Transporter | undefined

function getTransporter(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST!,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } }
      : {}),
  })
  return transporter
}

export type Attachment = { filename: string; content: Buffer; contentType: string }

export type Email = {
  to: string
  subject: string
  html: string
  text: string
  /** Files sent with the message, such as an invoice PDF. */
  attachments?: Attachment[]
}

/**
 * Sends one message.
 *
 * Callers should treat delivery as best-effort and never block a state change
 * on it: an invitation that is created but whose email fails is recoverable
 * (resend it), whereas an invitation rolled back because a mail server was
 * briefly down is a confusing dead end. From S2 this moves behind the outbox
 * so retries are automatic.
 */
const outbox: Email[] = []

/** Messages captured by the memory driver. Tests only. */
export function sentEmails(): readonly Email[] {
  return outbox
}

export function clearSentEmails(): void {
  outbox.length = 0
}

export async function sendEmail(email: Email): Promise<void> {
  if (env.MAIL_DRIVER === 'memory') {
    outbox.push(email)
    return
  }
  if (env.MAIL_DRIVER === 'resend') return sendWithResend(email)
  await getTransporter().sendMail({
    from: env.MAIL_FROM,
    to: email.to,
    subject: email.subject,
    text: email.text,
    html: email.html,
    ...(email.attachments?.length
      ? { attachments: email.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) }
      : {}),
  })
}

/** Resend's API base. Changed only by tests, to point at a fake. */
const resendBase = () => process.env.RESEND_API_BASE ?? 'https://api.resend.com'

/**
 * Sends one message through Resend's HTTP API. The key goes in a header and
 * is never part of an error: a failure names the status and Resend's own
 * message, which is what a person needs to fix it (an unverified domain, a
 * revoked key).
 */
async function sendWithResend(email: Email): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${resendBase()}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.attachments?.length
          ? { attachments: email.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64'), content_type: a.contentType })) }
          : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new Error(`Resend could not be reached: ${error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error'}`)
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(`Resend refused the message (${response.status}): ${body?.message ?? response.statusText}`)
  }
}

export async function verifyMailConnection(): Promise<boolean> {
  // A sending-only Resend key may not read anything, so there is nothing to
  // ask without sending: having a key is as far as a check can go.
  if (env.MAIL_DRIVER === 'resend') return Boolean(env.RESEND_API_KEY)
  if (env.MAIL_DRIVER === 'memory') return true
  try {
    await getTransporter().verify()
    return true
  } catch {
    return false
  }
}
