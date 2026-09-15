import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, isPermission, type Permission } from './statements.ts'
import { permissionsForRole, ROLES, roleHasPermission, type Role } from './roles.ts'

describe('the permission matrix', () => {
  it('grants only permissions that exist', () => {
    // A typo in the matrix grants nothing at all, silently. Without this test
    // the symptom is "why can't finance send invoices?" months later.
    for (const role of ROLES) {
      for (const permission of permissionsForRole(role)) {
        expect(isPermission(permission), `${role} grants unknown "${permission}"`).toBe(true)
      }
    }
  })

  it('gives every role a way to see the organization it belongs to', () => {
    for (const role of ROLES) {
      expect(roleHasPermission(role, 'organization:read'), role).toBe(true)
    }
  })

  it('gives no role zero permissions', () => {
    for (const role of ROLES) {
      expect(permissionsForRole(role).size, `${role} can do nothing`).toBeGreaterThan(0)
    }
  })
})

describe('owner and admin', () => {
  it('lets the owner do everything', () => {
    expect(permissionsForRole('owner').size).toBe(ALL_PERMISSIONS.length)
  })

  it('differs from admin only by deleting the organization', () => {
    const owner = permissionsForRole('owner')
    const admin = permissionsForRole('admin')
    const difference = [...owner].filter((p) => !admin.has(p))
    expect(difference).toEqual(['organization:delete'])
  })
})

describe('separation of duties', () => {
  // These encode deliberate product decisions. If one fails, the matrix
  // changed -- confirm that was intended rather than editing the test.
  const cases: Array<[Role, Permission, boolean, string]> = [
    ['developer', 'invoice:read', false, 'commercial terms are not delivery information'],
    ['developer', 'payment:read', false, 'as above'],
    ['developer', 'report:readFinancial', false, 'margins are not delivery information'],
    ['developer', 'timeEntry:create', true, 'developers log their own time'],
    ['developer', 'timeEntryAll:read', false, 'but not each other\'s'],
    ['developer', 'timeEntryAll:manage', false, 'nor change it'],
    ['developer', 'rate:update', false, 'rates are commercial terms'],
    ['manager', 'timeEntryAll:manage', true, 'managers correct their team\'s timesheets'],
    ['manager', 'rate:update', true, 'and set what people cost and bill'],
    ['finance', 'rate:update', true, 'finance owns rates'],
    ['finance', 'timeEntryAll:manage', false, 'but does not rewrite what people worked'],

    ['finance', 'task:update', false, 'finance does not reassign delivery work'],
    ['finance', 'invoice:send', true, 'finance owns billing'],
    ['finance', 'payment:create', true, 'and recording receipts'],

    ['accountManager', 'payment:create', false, 'recording money received is a finance duty'],
    ['accountManager', 'quote:send', true, 'account managers quote'],
    ['accountManager', 'taxRate:read', true, 'and choose the tax on each line'],
    ['accountManager', 'taxRate:create', false, 'but tax configuration is a finance duty'],
    ['developer', 'quote:read', false, 'quotes are commercial terms'],
    ['accountManager', 'lead:convert', true, 'and convert won work'],

    ['manager', 'report:readFinancial', true, 'judging a project requires its margin'],
    ['manager', 'invoice:create', false, 'raising invoices is a finance duty'],
    ['developer', 'comment:create', true, 'developers discuss the work'],
    ['developer', 'comment:moderate', false, "but do not edit each other's comments"],
    ['developer', 'project:update', false, 'nor change the project itself'],
  ]

  it.each(cases)('%s / %s -> %s (%s)', (role, permission, expected) => {
    expect(roleHasPermission(role, permission)).toBe(expected)
  })
})
