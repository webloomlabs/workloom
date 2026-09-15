import { describe, expect, it } from 'vitest'
import { grantsForRole } from './access-control.ts'

/**
 * These pin the translation between Workloom's permissions and the ones
 * Better Auth checks internally. When it is wrong the symptom is an owner who
 * cannot invite anyone -- which is exactly how the gap was found.
 */
describe('Better Auth grants', () => {
  it('lets anyone who may invite members create and cancel invitations', () => {
    const owner = grantsForRole('owner')
    expect(owner.invitation).toEqual(expect.arrayContaining(['create', 'cancel']))
    expect(owner.member).toEqual(expect.arrayContaining(['create', 'update', 'delete']))
  })

  it('keeps Workloom actions alongside the Better Auth ones on the shared member resource', () => {
    // `member` exists in both vocabularies; neither side's actions may be lost.
    const owner = grantsForRole('owner')
    expect(owner.member).toEqual(expect.arrayContaining(['read', 'invite', 'remove', 'delete']))
  })

  it('reserves deleting the organization for the owner', () => {
    expect(grantsForRole('owner').organization).toContain('delete')
    expect(grantsForRole('admin').organization).not.toContain('delete')
  })

  it('gives roles without member management no way to invite', () => {
    for (const role of ['developer', 'finance', 'accountManager', 'manager'] as const) {
      expect(grantsForRole(role).invitation, role).toBeUndefined()
    }
  })

  it('never grants teams or dynamic access control, which are not in the MVP', () => {
    const owner = grantsForRole('owner')
    expect(owner.team).toBeUndefined()
    expect(owner.ac).toBeUndefined()
  })
})
