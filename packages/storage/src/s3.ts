import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '@workloom/config'
import {
  assertSafeKey,
  assertSafePrefix,
  attachmentDisposition,
  inlineDisposition,
  servesInline,
  type PutOptions,
  type SignedUrlOptions,
  type Storage,
  type StoredObject,
} from './types.ts'

/**
 * S3-compatible object storage.
 *
 * Path-style addressing is the default because most self-hosted S3
 * implementations (MinIO, Garage, Ceph) require it; AWS itself accepts it too.
 */
export class S3Storage implements Storage {
  private readonly bucket = env.S3_BUCKET!
  private readonly client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    },
  })

  async put(key: string, body: Buffer | Uint8Array, options?: PutOptions): Promise<StoredObject> {
    assertSafeKey(key)
    const contentType = options?.contentType ?? 'application/octet-stream'
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(options?.filename ? { ContentDisposition: attachmentDisposition(options.filename) } : {}),
      }),
    )
    return { key, size: body.byteLength, contentType }
  }

  async putFile(key: string, path: string, options?: PutOptions): Promise<StoredObject> {
    assertSafeKey(key)
    const contentType = options?.contentType ?? 'application/octet-stream'
    const { size } = await stat(path)
    // A stream with its length known: S3 takes up to 5 GB in one request, and nothing is buffered here.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: contentType,
        ...(options?.filename ? { ContentDisposition: attachmentDisposition(options.filename) } : {}),
      }),
    )
    return { key, size, contentType }
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key)
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )
    return Buffer.from(await result.Body!.transformToByteArray())
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key)
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  /**
   * One object at a time rather than DeleteObjects: the batch call requires a
   * request checksum that several S3-compatible servers reject, and this runs
   * once per organization reset, not on any hot path.
   */
  async deletePrefix(prefix: string): Promise<number> {
    assertSafePrefix(prefix)
    let deleted = 0
    let token: string | undefined
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      )
      const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k))
      for (let i = 0; i < keys.length; i += 16) {
        await Promise.all(
          keys.slice(i, i + 16).map((Key) => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }))),
        )
      }
      deleted += keys.length
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return deleted
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key)
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch {
      return false
    }
  }

  async signedUrl(key: string, options: SignedUrlOptions = {}): Promise<string> {
    assertSafeKey(key)
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: (servesInline(options) ? inlineDisposition : attachmentDisposition)(options.filename ?? key.split('/').pop()!),
      ResponseContentType: options.contentType ?? 'application/octet-stream',
    })
    return getSignedUrl(this.client, command, { expiresIn: options.expiresInSeconds ?? 300 })
  }
}
