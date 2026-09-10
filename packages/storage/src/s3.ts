import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '@workloom/config'
import { assertSafeKey, type PutOptions, type Storage, type StoredObject } from './types.ts'

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
        ...(options?.filename
          ? { ContentDisposition: `attachment; filename="${options.filename.replace(/"/g, '')}"` }
          : {}),
      }),
    )
    return { key, size: body.byteLength, contentType }
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

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key)
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch {
      return false
    }
  }

  async signedUrl(key: string, expiresInSeconds = 300): Promise<string> {
    assertSafeKey(key)
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    })
  }
}
