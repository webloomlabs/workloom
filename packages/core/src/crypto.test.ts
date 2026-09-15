import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptSecret, DecryptionError, encryptSecret, needsReencryption, type Keyring } from './crypto.ts'

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
