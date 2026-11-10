export type StoredObject = {
  /** Opaque storage key. Never derived from user input without sanitising. */
  key: string
  size: number
  contentType: string
}

export type PutOptions = {
  contentType?: string
  /** Original filename, used for the download disposition. */
  filename?: string
}

export interface Storage {
  put(key: string, body: Buffer | Uint8Array, options?: PutOptions): Promise<StoredObject>
  /** Stores a file from disk without reading it into memory: for large generated files such as a tax pack. */
  putFile(key: string, path: string, options?: PutOptions): Promise<StoredObject>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  /**
   * Deletes every object whose key starts with `prefix`, which must end in
   * "/" -- a whole folder, never a partial name. Returns how many went. Used
   * to remove all of an organization's files, which are all kept under
   * `<organization id>/`.
   */
  deletePrefix(prefix: string): Promise<number>
  exists(key: string): Promise<boolean>
  /**
   * A time-limited URL the browser can fetch directly. The local driver
   * returns an application route instead of a presigned URL, since there is
   * no separate storage host to sign against.
   *
   * Files are always served as downloads, never rendered inline: an uploaded
   * HTML or SVG file shown by the browser on the application's own origin
   * would run its scripts as the viewer.
   */
  signedUrl(key: string, options?: SignedUrlOptions): Promise<string>
}

export type SignedUrlOptions = {
  expiresInSeconds?: number
  /** The name the browser saves the file as. */
  filename?: string
  contentType?: string
  /**
   * Show the file in the browser rather than download it. Honoured only for
   * the raster image types in `INLINE_TYPES`, whose bytes the caller has
   * checked: an image cannot run script, an HTML or SVG file can.
   */
  inline?: boolean
}

/** The only types ever served inline: raster images, which cannot carry script. */
export const INLINE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

/** Whether a file of this type, asked to be shown inline, may be. */
export function servesInline(options: { inline?: boolean | undefined; contentType?: string | undefined }): boolean {
  return Boolean(options.inline && options.contentType && INLINE_TYPES.includes(options.contentType))
}

/** A Content-Disposition header that shows the file in the browser, for an inline-safe type. */
export function inlineDisposition(filename: string): string {
  return attachmentDisposition(filename).replace(/^attachment/, 'inline')
}

/** A Content-Disposition header value that is safe for any filename. */
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/**
 * Storage keys are generated, never taken from user input. This guards the
 * boundary anyway: a key containing `..` or a leading slash would let the
 * local driver write outside its root.
 */
export function assertSafeKey(key: string): void {
  if (key.length === 0 || key.startsWith('/') || key.split('/').some((s) => s === '..' || s === '')) {
    throw new TypeError(`unsafe storage key: ${key}`)
  }
}

/**
 * A prefix is a folder: safe as a key once its trailing slash is off, and
 * never empty, so that no mistake can reach "delete everything".
 */
export function assertSafePrefix(prefix: string): void {
  if (!prefix.endsWith('/')) throw new TypeError(`storage prefix must end in "/": ${prefix}`)
  assertSafeKey(prefix.slice(0, -1))
}
