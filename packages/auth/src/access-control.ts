import { createAccessControl } from 'better-auth/plugins/access'
import { defaultStatements } from 'better-auth/plugins/organization/access'
import {
  permissionsForRole,
  ROLES,
  STATEMENTS,
  type Permission,
  type Role,
} from '@workloom/core/permissions'

/**
 * Bridges Workloom's permission matrix into Better Auth's access control.
 *
 * Better Auth governs organization operations (inviting, removing members,
 * updating the organization); Workloom's registry governs domain operations.
 * The two speak different vocabularies -- Better Auth checks
 * `invitation:create` and `member:delete`, where Workloom says `member:invite`
 * and `member:remove` -- and they collide on the `member` resource.
 *
 * So the statements are merged, and Better Auth's grants are DERIVED from
 * Workloom's matrix rather than configured beside it. There is still exactly
 * one place that decides what a role may do.
 */

type StatementMap = Record<string, string[]>

function mergeStatements(...sources: StatementMap[]): StatementMap {
  const merged: StatementMap = {}
  for (const source of sources) {
    for (const [resource, actions] of Object.entries(source)) {
      merged[resource] = [...new Set([...(merged[resource] ?? []), ...actions])]
    }
  }
  return merged
}

const statements = mergeStatements(
  STATEMENTS as unknown as StatementMap,
  defaultStatements as unknown as StatementMap,
)

export const accessControl = createAccessControl(statements)

/**
 * Workloom permission -> the Better Auth grants it implies.
 *
 * Anything absent here grants nothing inside Better Auth. Teams and dynamic
 * access control (`team:*`, `ac:*`) are deliberately unmapped: neither is part
 * of the MVP, and an unmapped capability is one nobody can reach by accident.
 */
const BETTER_AUTH_EQUIVALENTS: Partial<Record<Permission, Array<[string, string]>>> = {
  'organization:update': [['organization', 'update']],
  'organization:delete': [['organization', 'delete']],
  'member:invite': [
    ['invitation', 'create'],
    ['invitation', 'cancel'],
    ['member', 'create'],
  ],
  'member:update': [['member', 'update']],
  'member:remove': [['member', 'delete']],
}

/** A role's Workloom permissions plus the Better Auth grants they imply. */
export function grantsForRole(role: Role): StatementMap {
  const grants: StatementMap = {}
  const add = (resource: string, action: string) => {
    const actions = (grants[resource] ??= [])
    if (!actions.includes(action)) actions.push(action)
  }

  for (const permission of permissionsForRole(role)) {
    const [resource, action] = permission.split(':') as [string, string]
    add(resource, action)
    for (const [baResource, baAction] of BETTER_AUTH_EQUIVALENTS[permission] ?? []) {
      add(baResource, baAction)
    }
  }
  return grants
}

export const roles = ROLES.reduce(
  (acc, role) => {
    acc[role] = accessControl.newRole(grantsForRole(role))
    return acc
  },
  {} as Record<Role, ReturnType<typeof accessControl.newRole>>,
)
