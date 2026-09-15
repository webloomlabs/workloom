import { describe, expect, it } from 'vitest'
import { isPermission } from '../../permissions/statements.ts'
import { isShipped } from '../../release.ts'
import { CLIENT_SECTION_KEYS, CLIENT_SECTIONS, SECTION_COUNTERS, UNCOUNTED_SECTIONS } from './clients.ts'

/**
 * The client view's sections are declared ahead of the slices that build them.
 * These tests keep the declaration honest as slices ship.
 */
describe('client view sections', () => {
  it('counts the records of every section whose slice has shipped', () => {
    // Fails the day a slice is added to SHIPPED_SLICES without its section
    // being wired into the client view. Add a counter in clients.ts, and the
    // tab's content on the company page.
    const missing = CLIENT_SECTION_KEYS.filter(
      (key) => isShipped(CLIENT_SECTIONS[key].since) && !UNCOUNTED_SECTIONS.includes(key) && !SECTION_COUNTERS[key],
    )
    expect(missing).toEqual([])
  })

  it('counts nothing for a section that has not shipped', () => {
    // A counter for an unshipped section means the registry says "upcoming"
    // about something that already exists -- or a slice forgot to ship itself.
    const premature = CLIENT_SECTION_KEYS.filter(
      (key) => SECTION_COUNTERS[key] && !isShipped(CLIENT_SECTIONS[key].since),
    )
    expect(premature).toEqual([])
  })

  it('covers everything the specification puts on a client', () => {
    // Spec §7. Contracts are part of quotes in the MVP.
    expect(CLIENT_SECTION_KEYS).toEqual(
      expect.arrayContaining([
        'contacts', 'projects', 'quotes', 'invoices', 'payments', 'expenses',
        'support', 'maintenance', 'infrastructure', 'documents', 'activity',
      ]),
    )
  })

  it('gates sections only on permissions that exist', () => {
    for (const key of CLIENT_SECTION_KEYS) {
      const permission = (CLIENT_SECTIONS[key] as { permission?: string }).permission
      if (permission) expect(isPermission(permission), key).toBe(true)
    }
  })
})
