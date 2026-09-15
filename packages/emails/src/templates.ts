import { button, escapeHtml, layout } from './layout.ts'
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
