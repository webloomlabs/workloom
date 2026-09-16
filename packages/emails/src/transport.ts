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

export async function verifyMailConnection(): Promise<boolean> {
  try {
    await getTransporter().verify()
    return true
  } catch {
    return false
  }
}
