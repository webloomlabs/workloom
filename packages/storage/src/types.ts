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
   */
  signedUrl(key: string, expiresInSeconds?: number): Promise<string>
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
