import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  it('stores a file from disk', async () => {
    const storage = new LocalStorage()
    const source = join(root, '..', `workloom-putfile-${Date.now()}.bin`)
    await writeFile(source, Buffer.from('a large zip, in spirit'))
    const stored = await storage.putFile('org/packs/pack.zip', source, { contentType: 'application/zip' })
    expect(stored).toMatchObject({ key: 'org/packs/pack.zip', size: 22, contentType: 'application/zip' })
    expect((await storage.get('org/packs/pack.zip')).toString()).toBe('a large zip, in spirit')
    await rm(source)
  })

  it('refuses keys that would escape its directory', async () => {
    const storage = new LocalStorage()
    for (const key of ['../outside', '/etc/passwd', 'a//b', 'a/../../b', '']) {
      await expect(storage.put(key, Buffer.from('x')), key).rejects.toThrow(/unsafe storage key/)
    }
  })

  it('deletes a whole folder, and only that folder', async () => {
    const storage = new LocalStorage()
    await storage.put('org-one/documents/a.pdf', Buffer.from('a'))
    await storage.put('org-one/receipts/e/b.jpg', Buffer.from('b'))
    await storage.put('org-one-and-more/c.pdf', Buffer.from('c'))
    await storage.put('org-two/d.pdf', Buffer.from('d'))

    expect(await storage.deletePrefix('org-one/')).toBe(2)
    expect(await storage.exists('org-one/documents/a.pdf')).toBe(false)
    expect(await storage.exists('org-one/receipts/e/b.jpg')).toBe(false)
    // A neighbour whose name merely starts the same way is not in the folder.
    expect(await storage.exists('org-one-and-more/c.pdf')).toBe(true)
    expect(await storage.exists('org-two/d.pdf')).toBe(true)
    expect(await storage.deletePrefix('org-one/')).toBe(0)
  })

  it('refuses a prefix that is not one safe folder', async () => {
    const storage = new LocalStorage()
    for (const prefix of ['', '/', 'org', '../', 'a/../', '/etc/']) {
      await expect(storage.deletePrefix(prefix), prefix).rejects.toThrow(/storage (key|prefix)/)
    }
  })
})

describe('signed URLs', () => {
  it('verify with the name and type they were issued for', async () => {
    const url = new URL(await new LocalStorage().signedUrl('org/a/report.pdf', { filename: 'Q3 report.pdf', contentType: 'application/pdf' }))
    expect(url.pathname).toBe('/api/files')
    expect(LocalStorage.verify(url.searchParams)).toEqual({ key: 'org/a/report.pdf', name: 'Q3 report.pdf', type: 'application/pdf', inline: false })
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

describe('showing an image instead of downloading it', () => {
  it('is signed into the URL, and honoured only for raster images', async () => {
    const store = new LocalStorage()
    const image = new URL(await store.signedUrl('org/receipts/a', { contentType: 'image/jpeg', filename: 'r.jpg', inline: true }))
    expect(LocalStorage.verify(image.searchParams)?.inline).toBe(true)

    // Asked for, but not an image that cannot carry script: still a download.
    const pdf = new URL(await store.signedUrl('org/receipts/b', { contentType: 'application/pdf', filename: 'r.pdf', inline: true }))
    expect(LocalStorage.verify(pdf.searchParams)?.inline).toBe(false)
    const svg = new URL(await store.signedUrl('org/receipts/c', { contentType: 'image/svg+xml', filename: 'r.svg', inline: true }))
    expect(LocalStorage.verify(svg.searchParams)?.inline).toBe(false)

    // Adding the flag to a download link breaks its signature.
    const download = new URL(await store.signedUrl('org/receipts/d', { contentType: 'image/jpeg', filename: 'r.jpg' }))
    download.searchParams.set('disposition', 'inline')
    expect(LocalStorage.verify(download.searchParams)).toBeNull()
    // Changing the type of an inline link does too.
    image.searchParams.set('type', 'text/html')
    expect(LocalStorage.verify(image.searchParams)).toBeNull()
  })
})
