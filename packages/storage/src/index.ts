import { env } from '@workloom/config'
import { LocalStorage } from './local.ts'
import { S3Storage } from './s3.ts'
import type { Storage } from './types.ts'

export type { Storage, StoredObject, PutOptions, SignedUrlOptions } from './types.ts'
export { attachmentDisposition } from './types.ts'
export { LocalStorage } from './local.ts'

let instance: Storage | undefined

/**
 * The configured storage backend.
 *
 * Both drivers sit behind one interface so that the rest of the application
 * never branches on which is in use. Local disk is the default because a
 * single-server self-hosted install should not require object storage to
 * work; S3 is what makes the app horizontally scalable later.
 */
export function storage(): Storage {
  instance ??= env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage()
  return instance
}
