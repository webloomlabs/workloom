import { button, escapeHtml, layout } from './layout.ts'
import { formatAmount } from './money.ts'
import type { Email } from './transport.ts'

export function invitationEmail(options: {
  to: string
  organizationName: string
  inviterName: string
  role: string
  acceptUrl: string
  expiresInDays: number
}): Email {
  const org = escapeHtml(options.organizationName)
  const inviter = escapeHtml(options.inviterName)

  return {
    to: options.to,
    subject: `${options.inviterName} invited you to ${options.organizationName} on Workloom`,
    html: layout({
      heading: `Join ${org} on Workloom`,
      body: `
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
          ${inviter} has invited you to join <strong>${org}</strong> as ${escapeHtml(options.role)}.
        </p>
        <p style="margin:0 0 24px;">${button(options.acceptUrl, 'Accept invitation')}</p>
        <p style="margin:0;font-size:13px;color:#78716c;line-height:1.6;">
          This invitation expires in ${options.expiresInDays} days.
          If you weren't expecting it, you can ignore this email.
        </p>`,
    }),
    text: [
      `${options.inviterName} has invited you to join ${options.organizationName} on Workloom as ${options.role}.`,
      '',
      `Accept: ${options.acceptUrl}`,
      '',
      `This invitation expires in ${options.expiresInDays} days.`,
      `If you weren't expecting it, you can ignore this email.`,
    ].join('\n'),
  }
}

export function passwordResetEmail(options: { to: string; resetUrl: string }): Email {
  return {
    to: options.to,
    subject: 'Reset your Workloom password',
    html: layout({
      heading: 'Reset your password',
      body: `
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;">
          Use the link below to choose a new password. It expires in one hour.
        </p>
        <p style="margin:0 0 24px;">${button(options.resetUrl, 'Choose a new password')}</p>
        <p style="margin:0;font-size:13px;color:#78716c;line-height:1.6;">
          If you didn't request this, nothing has changed and you can ignore this email.
        </p>`,
    }),
    text: [
      'Use the link below to choose a new Workloom password. It expires in one hour.',
      '',
      options.resetUrl,
      '',
      "If you didn't request this, nothing has changed and you can ignore this email.",
    ].join('\n'),
  }
}

export function verifyEmailEmail(options: { to: string; name: string; verifyUrl: string }): Email {
  return {
    to: options.to,
    subject: 'Confirm your email for Workloom',
    html: layout({
      heading: 'Confirm your email',
      body: `
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
          Hi ${escapeHtml(options.name)}, confirm this address to finish setting up your account.
        </p>
        <p style="margin:0 0 24px;">${button(options.verifyUrl, 'Confirm email')}</p>
        <p style="margin:0;font-size:13px;color:#78716c;line-height:1.6;">
          The link expires in 24 hours. If you didn't create a Workloom account, ignore this email.
        </p>`,
    }),
    text: [
      `Hi ${options.name}, confirm this address to finish setting up your Workloom account.`,
      '',
      options.verifyUrl,
      '',
      "The link expires in 24 hours. If you didn't create a Workloom account, ignore this email.",
    ].join('\n'),
  }
}

/**
 * The invoice as it reaches the client: what it is for, what is owed, when it
 * is due, and a link that needs no account. The PDF travels with it, because a
 * client's accounts payable system usually wants the file, not a link.
 */
export function invoiceEmail(options: {
  to: string
  organization: string
  number: string
  title: string
  total: number
  /**
   * What is still to pay: less than the total when part has been paid, or
   * when the invoice takes an earlier one off. Defaults to the total.
   */
  amountDue?: number
  currency: string
  /** Null for an invoice due on an event without a date yet. */
  dueDate: string | null
  /** When it is due, in words: "At launch". */
  dueLabel?: string | null
  url: string
}): Email {
  const due = options.amountDue ?? options.total
  const amount = formatAmount(due, options.currency)
  const org = escapeHtml(options.organization)
  const when = options.dueDate ? `due ${options.dueDate}` : options.dueLabel ? `due ${options.dueLabel.charAt(0).toLowerCase()}${options.dueLabel.slice(1)}` : null
  const balance = due !== options.total ? ` (balance due on a total of ${formatAmount(options.total, options.currency)})` : ''
  return {
    to: options.to,
    subject: `Invoice ${options.number} from ${options.organization} — ${amount}`,
    html: layout({
      heading: `Invoice ${escapeHtml(options.number)}`,
      body: `
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
          ${org} has sent you an invoice for <strong>${escapeHtml(amount)}</strong>${escapeHtml(balance)}
          (${escapeHtml(options.title)})${when ? `, ${escapeHtml(when)}` : ''}.
        </p>
        <p style="margin:0 0 24px;">${button(options.url, 'View the invoice')}</p>
        <p style="margin:0;font-size:13px;color:#78716c;line-height:1.6;">
          The invoice is attached as a PDF. Reply to this email with any questions.
        </p>`,
    }),
    text: [
      `${options.organization} has sent you invoice ${options.number} for ${amount}${balance} (${options.title}).`,
      ...(when ? [`${when.charAt(0).toUpperCase()}${when.slice(1)}.`] : []),
      '',
      `View it: ${options.url}`,
      '',
      'The invoice is attached as a PDF.',
    ].join('\n'),
  }
}

/**
 * A project has crossed a budget threshold. Sent to its owner, once per
 * threshold per budget period, while there is still room to act.
 */
export function budgetAlertEmail(options: {
  to: string
  project: string
  measure: 'cost' | 'hours'
  percent: number
  threshold: number
  used: { minor: number; currency: string } | { hours: number }
  limit: { minor: number; currency: string } | { hours: number }
  /** The budget period, for a budget that is per period: "2026-11-01 to 2026-11-30". */
  period: string | null
  url: string
}): Email {
  const show = (v: { minor: number; currency: string } | { hours: number }) => ('hours' in v ? `${v.hours} h` : formatAmount(v.minor, v.currency))
  const what = options.measure === 'cost' ? 'its cost budget' : 'its hours budget'
  // At the 100% threshold the budget is used up; past it, overspent.
  const over = options.threshold >= 100 && options.percent > 100
  const full = options.threshold >= 100 && !over
  const headline = over
    ? `${options.project} is over ${what}`
    : full
      ? `${options.project} has used all of ${what}`
      : `${options.project} has used ${options.percent}% of ${what}`
  const when = options.period ? ` for ${options.period}` : ''
  const sentence = `${show(options.used)} of ${show(options.limit)}${when} (${options.percent}%).`
  return {
    to: options.to,
    subject: headline,
    html: layout({
      heading: escapeHtml(headline),
      body: `
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">${escapeHtml(sentence)}</p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
          ${over ? 'Raise a revision, renegotiate, or decide to absorb it.' : full ? 'Anything more goes over it. Raise a revision or renegotiate before it does.' : 'There is still room to act: check the scope and the time being logged.'}
        </p>
        <p style="margin:0 0 24px;">${button(options.url, 'Open the project')}</p>`,
    }),
    text: [headline, '', sentence, '', `Open the project: ${options.url}`].join('\n'),
  }
}

export function quoteEmail(options: { to: string; organization: string; number: string; title: string; total: number; currency: string; validUntil: string }): Email {
  const amount = formatAmount(options.total, options.currency)
  const org = escapeHtml(options.organization)
  return {
    to: options.to,
    subject: `Quote ${options.number} from ${options.organization} — ${amount}`,
    html: layout({
      heading: `Quote ${escapeHtml(options.number)}`,
      body: `
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
          ${org} has sent you a quote for <strong>${escapeHtml(amount)}</strong> (${escapeHtml(options.title)}), valid until ${escapeHtml(options.validUntil)}.
        </p>
        <p style="margin:0;font-size:13px;color:#78716c;line-height:1.6;">
          The quote is attached as a PDF. Reply to this email to accept it or with any questions.
        </p>`,
    }),
    text: [
      `${options.organization} has sent you quote ${options.number} for ${amount} (${options.title}).`,
      `Valid until ${options.validUntil}.`,
      '',
      'The quote is attached as a PDF. Reply to this email to accept it or with any questions.',
    ].join('\n'),
  }
}

/**
 * The second step of an organization reset: a code that proves the person at
 * the keyboard also holds the owner's inbox. It says plainly what the code
 * does, so that someone who did not ask for it knows their password is out.
 */
export function organizationResetCodeEmail(options: {
  to: string
  organizationName: string
  code: string
  expiresInMinutes: number
}): Email {
  const org = escapeHtml(options.organizationName)
  return {
    to: options.to,
    subject: `Your code to reset ${options.organizationName} on Workloom`,
    html: layout({
      heading: `Reset ${org}`,
      body: `
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
          Someone signed in as you asked to <strong>permanently delete all of ${org}'s data</strong>
          and settings on Workloom. Enter this code to confirm:
        </p>
        <p style="margin:0 0 24px;font-size:28px;font-weight:600;letter-spacing:6px;font-family:ui-monospace,Menlo,monospace;">${escapeHtml(options.code)}</p>
        <p style="margin:0;font-size:13px;color:#78716c;line-height:1.6;">
          The code expires in ${options.expiresInMinutes} minutes and works once.
          If this wasn't you, don't share it: someone has your password, so change it now.
        </p>`,
    }),
    text: [
      `Someone signed in as you asked to permanently delete all of ${options.organizationName}'s data and settings on Workloom.`,
      '',
      `Code: ${options.code}`,
      '',
      `The code expires in ${options.expiresInMinutes} minutes and works once.`,
      "If this wasn't you, don't share it: someone has your password, so change it now.",
    ].join('\n'),
  }
}
