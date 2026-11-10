import { eq, schema, wipeTenantData, withTenant } from '@workloom/db'
import { storage } from '@workloom/storage'
import { writeAuditEntry } from '../audit.ts'
import type { Actor } from '../context.ts'
import { newId } from '../ids.ts'
import { telegramClient } from './integrations/telegram/bots.ts'

export type OrganizationResetResult = {
  /** Rows deleted, per table, for the tables that had any. */
  deleted: Record<string, number>
  /** Stored files deleted: attachments, receipts, documents, tax packs, the logo. */
  files: number
}

/**
 * Returns an organization to how it was the day it was created: every
 * client, project, invoice, payment, bank line, file and setting goes; the
 * organization itself, its members, their accounts and the audit log stay.
 *
 * Deliberately not a procedure. Procedures are reachable through the REST API
 * with an API key, and this must only ever be reached by a person who has just
 * typed their password and a code from their inbox. It authorises nothing
 * itself: the one caller, `confirmOrganizationReset` in packages/auth, has
 * established all of that first.
 *
 * One transaction for the database, so it all goes or none of it does. The
 * files go after it commits, since storage cannot roll back; a failure there
 * is logged and leaves orphaned files behind, never orphaned rows.
 */
export async function resetOrganizationData(input: {
  organizationId: string
  actor: Actor
  ipAddress?: string | undefined
  userAgent?: string | undefined
}): Promise<OrganizationResetResult> {
  const { organizationId } = input

  const { deleted, unhook } = await withTenant(organizationId, async (tx) => {
    const [org] = await tx
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, organizationId))
      .limit(1)
    if (!org) throw new Error(`reset: organization ${organizationId} does not exist`)

    // Read before it goes: Telegram should stop pushing to this installation.
    const [bot] = await tx
      .select({ mode: schema.telegramBots.mode, tokenEncrypted: schema.telegramBots.tokenEncrypted })
      .from(schema.telegramBots)
      .limit(1)

    const counts = await wipeTenantData(tx, organizationId)

    // What lived on the organization row but pointed at the records: the
    // logo is a stored file, and the books lock date closed periods that no
    // longer have anything in them. The profile -- name, currency, address,
    // payment details -- is who the organization is, and stays.
    await tx
      .update(schema.organization)
      .set({ logoKey: null, booksLockedThrough: null })
      .where(eq(schema.organization.id, organizationId))

    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    const nonEmpty = Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0))
    await writeAuditEntry(tx, {
      organizationId,
      actor: input.actor,
      requestId: newId(),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      entry: {
        action: 'organization.reset',
        entityType: 'organization',
        entityId: organizationId,
        entityLabel: org.name,
        changes: { records: { from: total, to: 0 } },
        snapshot: { deleted: nonEmpty },
      },
    })

    return { deleted: nonEmpty, unhook: bot?.mode === 'webhook' ? bot : null }
  })

  let files = 0
  try {
    files = await storage().deletePrefix(`${organizationId}/`)
  } catch (error) {
    console.error(`[reset] organization ${organizationId}: the records are gone, but deleting its files failed`, error)
  }

  if (unhook) {
    // Best effort, as when the bot is disconnected by hand.
    try {
      await (await telegramClient(unhook)).deleteWebhook()
    } catch {
      // Telegram is told nothing; its pushes are refused, since there is no bot.
    }
  }

  return { deleted, files }
}
