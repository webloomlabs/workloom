import { describe, expect, it } from 'vitest'
import { invitationEmail } from './templates.ts'

describe('invitation email', () => {
  it('escapes interpolated values', () => {
    // Organization and user names are attacker-controlled in a multi-tenant
    // product: anyone who can create an organization can name it.
    const email = invitationEmail({
      to: 'someone@example.com',
      organizationName: '<script>alert(1)</script>',
      inviterName: 'Ann "Quote" O\'Brien',
      role: 'admin',
      acceptUrl: 'https://example.com/accept?token=abc',
      expiresInDays: 7,
    })

    expect(email.html).not.toContain('<script>')
    expect(email.html).toContain('&lt;script&gt;')
    expect(email.html).toContain('&quot;Quote&quot;')
  })

  it('carries the same accept link in both the html and text parts', () => {
    const url = 'https://example.com/accept?token=abc'
    const email = invitationEmail({
      to: 'someone@example.com',
      organizationName: 'Webloom Labs',
      inviterName: 'Ann',
      role: 'admin',
      acceptUrl: url,
      expiresInDays: 7,
    })
    expect(email.html).toContain(url)
    expect(email.text).toContain(url)
  })
})
