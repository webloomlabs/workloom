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
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
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
