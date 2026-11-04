import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { db, eq, schema, sql, withTenant } from '@workloom/db'
import { storage } from '@workloom/storage'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { buildContext } from '../../registry/index.ts'
import { packFiles, packReadme } from '../../reports/tax-pack.ts'
import { fiscalYearStarting } from '../../reports/fiscal.ts'
import { collectPackInput } from './books.ts'
import { packSummary } from './tax-packs.ts'

/**
 * Builds requested tax packs, for the worker.
 *
 * The figures are read in one short transaction; the zip is then written to
 * a temporary file -- receipts one at a time, so a year of photos never sits
 * in memory -- and stored from there. Organizations are listed by id and each
 * worked inside its own tenant scope, as everything cross-organization is.
 */

const MAX_ATTEMPTS = 3

export async function buildDueTaxPacks(now = new Date()): Promise<number> {
  const organizations = await db.select({ id: schema.organization.id }).from(schema.organization)
  let built = 0
  for (const { id: organizationId } of organizations) {
    const due = await withTenant(organizationId, (tx) =>
      tx
        .update(schema.taxPacks)
        .set({ attempts: sql`${schema.taxPacks.attempts} + 1` })
        .where(sql`${schema.taxPacks.id} = (select id from tax_packs where status = 'pending' and attempts < ${MAX_ATTEMPTS} order by requested_at limit 1 for update skip locked)`)
        .returning(),
    )
    for (const pack of due) {
      try {
        await buildPack(organizationId, pack, now)
        built += 1
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
        console.error(`tax pack ${pack.id} in ${organizationId} failed: ${message}`)
        await withTenant(organizationId, (tx) =>
          tx
            .update(schema.taxPacks)
            .set(pack.attempts >= MAX_ATTEMPTS ? { status: 'failed', error: message, completedAt: new Date() } : { error: message })
            .where(eq(schema.taxPacks.id, pack.id)),
        )
      }
    }
  }
  return built
}

async function buildPack(organizationId: string, pack: typeof schema.taxPacks.$inferSelect, now: Date): Promise<void> {
  const year = { ...fiscalYearStarting(Number(pack.periodStart.slice(0, 4)), Number(pack.periodStart.slice(5, 7))), label: pack.label }
  const input = await withTenant(organizationId, (tx) =>
    collectPackInput(buildContext({ organizationId, actor: { type: 'job', label: 'tax pack' }, role: null, permissions: new Set(), now }, tx), year, now),
  )
  const built = packFiles(input)

  const dir = await mkdtemp(join(tmpdir(), 'workloom-pack-'))
  const path = join(dir, 'pack.zip')
  try {
    const out = createWriteStream(path)
    const whole = createHash('sha256')
    let failure: Error | null = null
    const zip = new Zip((error, chunk, final) => {
      if (error) failure = error
      else {
        whole.update(chunk)
        out.write(chunk)
      }
      if (final || error) out.end()
    })
    const add = (name: string, bytes: Uint8Array, compress: boolean) => {
      const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
      zip.add(entry)
      entry.push(bytes, true)
    }

    const folder = `Tax pack ${input.year.label.replace('/', '-')}`
    const checksums: Array<{ path: string; sha256: string }> = []
    for (const file of built.files) {
      // Photos and PDFs are compressed already; text is not.
      const bytes = file.text !== undefined ? Buffer.from(file.text, 'utf8') : await storage().get(file.storageKey!)
      checksums.push({ path: file.path, sha256: createHash('sha256').update(bytes).digest('hex') })
      add(`${folder}/${file.path}`, bytes, file.text !== undefined)
    }
    add(`${folder}/README.txt`, Buffer.from(packReadme(input, built.pnl, built.warnings, checksums), 'utf8'), true)
    zip.end()
    await finished(out)
    if (failure) throw failure

    const key = `${organizationId}/tax-packs/${pack.id}.zip`
    const stored = await storage().putFile(key, path, { contentType: 'application/zip', filename: `${folder}.zip` })
    await withTenant(organizationId, (tx) =>
      tx
        .update(schema.taxPacks)
        .set({
          status: 'ready',
          storageKey: key,
          sha256: whole.digest('hex'),
          sizeBytes: stored.size,
          summary: packSummary(built, input),
          warnings: built.warnings,
          error: null,
          completedAt: new Date(),
        })
        .where(eq(schema.taxPacks.id, pack.id)),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
