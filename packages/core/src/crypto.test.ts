import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptSecret, DecryptionError, encryptSecret, needsReencryption, readLinkToken, signLinkToken, type Keyring } from './crypto.ts'

const key = () => randomBytes(32)

describe('secret encryption', () => {
  it('round-trips', () => {
    const keyring: Keyring = { current: key(), previous: [] }
    expect(decryptSecret(encryptSecret('whsec_abc', keyring), keyring)).toBe('whsec_abc')
  })

  it('never produces the same ciphertext twice', () => {
    // A fresh IV per encryption; identical secrets must not be recognisable.
    const keyring: Keyring = { current: key(), previous: [] }
    expect(encryptSecret('same', keyring)).not.toBe(encryptSecret('same', keyring))
  })

  it('still reads secrets encrypted under a previous key after rotation', () => {
    const old = key()
    const value = encryptSecret('whsec_abc', { current: old, previous: [] })
    const rotated: Keyring = { current: key(), previous: [old] }

    expect(decryptSecret(value, rotated)).toBe('whsec_abc')
    expect(needsReencryption(value, rotated)).toBe(true)
  })

  it('explains a missing key instead of failing opaquely', () => {
    const value = encryptSecret('whsec_abc', { current: key(), previous: [] })
    expect(() => decryptSecret(value, { current: key(), previous: [] })).toThrow(
      /WORKLOOM_PREVIOUS_ENCRYPTION_KEYS/,
    )
  })

  it('detects tampering', () => {
    const keyring: Keyring = { current: key(), previous: [] }
    const parts = encryptSecret('whsec_abc', keyring).split(':')
    const flipped = Buffer.from(parts[5]!, 'base64url')
    flipped[0]! ^= 1
    parts[5] = flipped.toString('base64url')
    expect(() => decryptSecret(parts.join(':'), keyring)).toThrow(DecryptionError)
  })
})

describe('signed links', () => {
  it('round-trips a payload and refuses anything altered', () => {
    const token = signLinkToken('document-link', 'invoice:org-1:doc-1')
    expect(readLinkToken('document-link', token)).toBe('invoice:org-1:doc-1')

    // A different purpose, a changed payload, and a changed signature are all refused.
    expect(readLinkToken('other-purpose', token)).toBeNull()
    const [payload, signature] = token.split('.')
    expect(readLinkToken('document-link', `${Buffer.from('invoice:org-2:doc-1').toString('base64url')}.${signature}`)).toBeNull()
    expect(readLinkToken('document-link', `${payload}.${'A'.repeat(43)}`)).toBeNull()
    for (const malformed of ['', 'no-dot', '.', 'a.b.c']) expect(readLinkToken('document-link', malformed)).toBeNull()
  })
})
