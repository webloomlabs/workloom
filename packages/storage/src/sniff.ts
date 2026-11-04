/**
 * What a file is, from its first bytes.
 *
 * The content type a browser sends with an upload is whatever the file was
 * named, or whatever the sender typed: an HTML page renamed `receipt.jpg`
 * arrives as `image/jpeg`. Where a file is going to be shown inline, printed,
 * or handed to something that parses it, the bytes decide -- not the label.
 *
 * Only the types Workloom accepts somewhere are recognised. Anything else is
 * null, and the caller refuses it.
 */

export type SniffedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/heic' | 'application/pdf'

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b)

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))

/** HEIF brands that mean an image an iPhone produced: HEIC, and the HEIF still-image family. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])

export function sniffContentType(bytes: Uint8Array): SniffedType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8, 12))) return 'image/heic'
  // A PDF header may follow a little junk, which readers tolerate; allow a short lead.
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024))
  if (head.indexOf('%PDF-') >= 0 && head.indexOf('%PDF-') < 1024) return 'application/pdf'
  return null
}

/** Whether the bytes are one of the given types. */
export function isOneOf(bytes: Uint8Array, types: readonly SniffedType[]): SniffedType | null {
  const type = sniffContentType(bytes)
  return type && types.includes(type) ? type : null
}
