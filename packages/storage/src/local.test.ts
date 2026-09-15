import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let root: string
let LocalStorage: typeof import('./local.ts').LocalStorage
let attachmentDisposition: typeof import('./types.ts').attachmentDisposition

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'workloom-storage-'))
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused@localhost/unused',
    APP_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'a'.repeat(32),
    WORKLOOM_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    MAIL_DRIVER: 'memory',
    MAIL_FROM: 'test@example.com',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_PATH: root,
  })
  ;({ LocalStorage } = await import('./local.ts'))
  ;({ attachmentDisposition } = await import('./types.ts'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('local storage', () => {
  it('round-trips bytes exactly', async () => {
    const storage = new LocalStorage()
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13])
    await storage.put('org/a/file.bin', bytes)
    expect(await storage.exists('org/a/file.bin')).toBe(true)
    expect(Buffer.compare(await storage.get('org/a/file.bin'), bytes)).toBe(0)
    await storage.delete('org/a/file.bin')
    expect(await storage.exists('org/a/file.bin')).toBe(false)
  })

  it('refuses keys that would escape its directory', async () => {
    const storage = new LocalStorage()
    for (const key of ['../outside', '/etc/passwd', 'a//b', 'a/../../b', '']) {
      await expect(storage.put(key, Buffer.from('x')), key).rejects.toThrow(/unsafe storage key/)
    }
  })
})

describe('signed URLs', () => {
  it('verify with the name and type they were issued for', async () => {
    const url = new URL(await new LocalStorage().signedUrl('org/a/report.pdf', { filename: 'Q3 report.pdf', contentType: 'application/pdf' }))
    expect(url.pathname).toBe('/api/files')
    expect(LocalStorage.verify(url.searchParams)).toEqual({ key: 'org/a/report.pdf', name: 'Q3 report.pdf', type: 'application/pdf' })
  })

  it('stop verifying when any parameter is changed', async () => {
    const url = new URL(await new LocalStorage().signedUrl('org/a/report.pdf', { filename: 'r.pdf', contentType: 'application/pdf' }))
    for (const [name, value] of [['key', 'org/b/secret.pdf'], ['type', 'text/html'], ['name', 'x.html'], ['expires', '9999999999']] as const) {
      const tampered = new URLSearchParams(url.searchParams)
      tampered.set(name, value)
      expect(LocalStorage.verify(tampered), name).toBeNull()
    }
    const unsigned = new URLSearchParams(url.searchParams)
    unsigned.delete('signature')
    expect(LocalStorage.verify(unsigned)).toBeNull()
  })

  it('expire', async () => {
    const url = new URL(await new LocalStorage().signedUrl('org/a/x', { expiresInSeconds: -1 }))
    expect(LocalStorage.verify(url.searchParams)).toBeNull()
  })
})

describe('download disposition', () => {
  it('always downloads, and survives awkward filenames', () => {
    expect(attachmentDisposition('plain.txt')).toBe(`attachment; filename="plain.txt"; filename*=UTF-8''plain.txt`)
    const tricky = attachmentDisposition('a"b\\c\r\nSet-Cookie: x.html')
    expect(tricky).not.toMatch(/[\r\n]/)
    expect(tricky.startsWith('attachment; filename="a_b_c__Set-Cookie: x.html"')).toBe(true)
    expect(attachmentDisposition('résumé.pdf')).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")
  })
})
