/**
 * The permission vocabulary.
 *
 * Permissions are `resource:action` strings. They are defined once here and
 * consumed by the role matrix, the procedure registry, API key scopes, and
 * Better Auth's access control -- rather than each maintaining its own list
 * and drifting apart.
 */
export const STATEMENTS = {
  organization: ['read', 'update', 'delete'],
  member: ['read', 'invite', 'update', 'remove'],
  apiKey: ['read', 'create', 'revoke'],
  webhook: ['read', 'create', 'update', 'delete'],
  auditLog: ['read'],

  company: ['read', 'create', 'update', 'archive'],
  contact: ['read', 'create', 'update', 'archive'],
  lead: ['read', 'create', 'update', 'convert', 'archive'],
  deal: ['read', 'create', 'update', 'archive'],
  activity: ['read', 'create', 'update', 'delete'],

  project: ['read', 'create', 'update', 'archive'],
  milestone: ['read', 'create', 'update', 'delete'],
  task: ['read', 'create', 'update', 'delete'],
  /**
   * Discussion on projects and tasks. Reading follows `project:read`. `moderate`
   * is editing or deleting other people's comments; everyone may edit their own.
   */
  comment: ['create', 'moderate'],
  timeEntry: ['read', 'create', 'update', 'delete'],
  /** Reading another person's time entries, as opposed to one's own. */
  timeEntryAll: ['read'],

  service: ['read', 'create', 'update', 'archive'],
  taxRate: ['read', 'create', 'update', 'archive'],
  quote: ['read', 'create', 'update', 'send', 'delete'],
  invoice: ['read', 'create', 'update', 'send', 'cancel', 'delete'],
  payment: ['read', 'create', 'update', 'delete'],
  expense: ['read', 'create', 'update', 'delete'],

  /** Financial reporting, including project profitability and margins. */
  report: ['read', 'readFinancial'],
} as const satisfies Record<string, readonly string[]>

export type Statements = typeof STATEMENTS
export type Resource = keyof Statements

export type Permission = {
  [R in Resource]: `${R}:${Statements[R][number]}`
}[Resource]

/** Every permission string, for the "everything" roles and for validation. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.entries(STATEMENTS).flatMap(
  ([resource, actions]) => (actions as readonly string[]).map((a) => `${resource}:${a}`),
) as Permission[]

const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS)

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value)
}
