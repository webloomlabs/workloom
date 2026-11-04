import { describe, expect, it } from 'vitest'
import { isOneOf, sniffContentType } from './sniff.ts'

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))

describe('sniffing a file from its bytes', () => {
  it('recognises the types Workloom accepts', () => {
    expect(sniffContentType(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'))).toBe('image/jpeg')
    expect(sniffContentType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png')
    expect(sniffContentType(bytes('GIF89a', [0, 0]))).toBe('image/gif')
    expect(sniffContentType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp')
    expect(sniffContentType(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0]))).toBe('image/heic')
    expect(sniffContentType(bytes([0, 0, 0, 0x18], 'ftypmif1', [0, 0, 0, 0]))).toBe('image/heic')
    expect(sniffContentType(bytes('%PDF-1.7\n'))).toBe('application/pdf')
  })

  it('does not believe a name: an HTML page called receipt.jpg is not an image', () => {
    expect(sniffContentType(bytes('<!doctype html><script>alert(1)</script>'))).toBeNull()
    expect(sniffContentType(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
  })

  it('refuses truncated and empty files', () => {
    expect(sniffContentType(new Uint8Array())).toBeNull()
    expect(sniffContentType(bytes([0xff, 0xd8]))).toBeNull()
    expect(sniffContentType(bytes('RIFF'))).toBeNull()
    expect(sniffContentType(bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 0, 0]))).toBeNull()
  })

  it('narrows to an allow-list', () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(isOneOf(png, ['image/png', 'image/jpeg'])).toBe('image/png')
    expect(isOneOf(png, ['application/pdf'])).toBeNull()
  })
})
