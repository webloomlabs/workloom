import { ALL_PERMISSIONS, type Permission, type Resource, STATEMENTS } from './statements.ts'

/**
 * Roles.
 *
 * Static rather than database-driven: custom roles are Phase 2, and a fixed
 * matrix is far easier to reason about and to test exhaustively. The shape
 * still anticipates the change -- list operations take an optional visibility
 * filter, so "developers see only their own projects" can arrive later
 * without altering any service signature.
 */
export const ROLES = [
  'owner',
  'admin',
  'manager',
  'developer',
  'accountManager',
  'finance',
] as const

export type Role = (typeof ROLES)[number]

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/** Every action on the given resources. */
function all(...resources: Resource[]): Permission[] {
  return resources.flatMap((r) =>
    (STATEMENTS[r] as readonly string[]).map((a) => `${r}:${a}` as Permission),
  )
}

const READ_ONLY_COMMERCIAL = [
  'company:read',
  'contact:read',
  'project:read',
  'milestone:read',
  'task:read',
] satisfies Permission[]

/**
 * The matrix.
 *
 * Read it as: what would this person's job actually require? A developer who
 * can read the invoice ledger is a needless disclosure of commercial terms; a
 * finance user who can reassign tasks is a needless way to break delivery.
 */
const MATRIX: Record<Role, readonly Permission[]> = {
  /** Owns the installation. Everything, including deleting the organization. */
  owner: ALL_PERMISSIONS,

  /** Everything operational; cannot delete the organization itself. */
  admin: ALL_PERMISSIONS.filter((p) => p !== 'organization:delete'),

  /**
   * Runs delivery. Full access to work and clients, and can see money,
   * because judging whether a project is worth continuing requires it.
   */
  manager: [
    'organization:read',
    'member:read',
    'auditLog:read',
    ...all('company', 'contact', 'lead', 'deal', 'activity'),
    ...all('project', 'milestone', 'task', 'timeEntry', 'timeEntryAll', 'comment'),
    'rate:update',
    ...all('service'),
    'taxRate:read',
    'quote:read',
    'quote:create',
    'quote:update',
    'quote:send',
    'invoice:read',
    'expense:read',
    'expense:create',
    'payment:read',
    ...all('ticket', 'maintenancePlan', 'infrastructure', 'document'),
    'billingSchedule:read',
    'report:read',
    'report:readFinancial',
  ],

  /**
   * Does the work. Sees projects and tasks, tracks their own time, and has no
   * access to commercial terms.
   */
  developer: [
    'organization:read',
    'member:read',
    ...READ_ONLY_COMMERCIAL,
    'activity:read',
    'task:create',
    'task:update',
    'comment:create',
    'milestone:read',
    ...all('timeEntry'),
    // Tickets are work, and the person who fixes the bug is the one who
    // answers for it. Raising and closing them is not theirs to decide.
    'ticket:read',
    'ticket:update',
    'maintenancePlan:read',
    'infrastructure:read',
    'document:read',
    'report:read',
  ],

  /**
   * Owns relationships. Full CRM, can quote, and can see whether a client has
   * paid -- but does not manage delivery internals or record payments.
   */
  accountManager: [
    'organization:read',
    'member:read',
    ...all('company', 'contact', 'lead', 'deal', 'activity'),
    ...READ_ONLY_COMMERCIAL,
    'comment:create',
    'service:read',
    'taxRate:read',
    'quote:read',
    'quote:create',
    'quote:update',
    'quote:send',
    'invoice:read',
    'invoice:create',
    'invoice:send',
    'payment:read',
    'expense:read',
    ...all('ticket', 'maintenancePlan', 'document'),
    'infrastructure:read',
    // Sets up a retainer; does not get to delete the billing behind one.
    'billingSchedule:read',
    'billingSchedule:create',
    'billingSchedule:update',
    'report:read',
  ],

  /**
   * Owns the money. Everything financial, plus the client and project context
   * needed to bill correctly -- and nothing that changes delivery.
   */
  finance: [
    'organization:read',
    'member:read',
    'auditLog:read',
    'company:read',
    'contact:read',
    'project:read',
    'milestone:read',
    'task:read',
    'timeEntry:read',
    'timeEntryAll:read',
    'rate:update',
    'comment:create',
    ...all('service', 'taxRate', 'quote', 'invoice', 'payment', 'expense'),
    ...all('billingSchedule'),
    // What is being billed for, and what the renewals cost.
    'maintenancePlan:read',
    'infrastructure:read',
    'document:read',
    'report:read',
    'report:readFinancial',
  ],
}

const FROZEN = ROLES.reduce(
  (acc, role) => {
    acc[role] = new Set(MATRIX[role])
    return acc
  },
  {} as Record<Role, ReadonlySet<Permission>>,
)

export function permissionsForRole(role: Role): ReadonlySet<Permission> {
  return FROZEN[role]
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return FROZEN[role].has(permission)
}
