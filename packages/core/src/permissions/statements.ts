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
  /**
   * Scope and price variations on a project, and extensions to its dates.
   * `accept` is the commercial decision -- agreeing that the client owes more --
   * so it is separate from editing the offer.
   */
  projectRevision: ['read', 'create', 'update', 'send', 'accept', 'delete'],
  /**
   * A project's staged billing plan. `release` raises the invoice for a stage,
   * which is the act that draws money down against the contract; `update` only
   * shapes the plan.
   */
  projectBilling: ['read', 'update', 'release'],
  milestone: ['read', 'create', 'update', 'delete'],
  task: ['read', 'create', 'update', 'delete'],
  /**
   * Discussion on projects and tasks. Reading follows `project:read`. `moderate`
   * is editing or deleting other people's comments; everyone may edit their own.
   */
  comment: ['create', 'moderate'],
  /** One's own time. */
  timeEntry: ['read', 'create', 'update', 'delete'],
  /**
   * Other people's time: `read` to see it, `manage` to log, edit, stop, or
   * delete it on their behalf.
   */
  timeEntryAll: ['read', 'manage'],
  /**
   * Default hourly rates for the organization and each person. Reading them
   * follows `report:readFinancial`.
   */
  rate: ['update'],

  service: ['read', 'create', 'update', 'archive'],
  taxRate: ['read', 'create', 'update', 'archive'],
  quote: ['read', 'create', 'update', 'send', 'delete'],
  invoice: ['read', 'create', 'update', 'send', 'cancel', 'delete'],
  payment: ['read', 'create', 'update', 'delete'],
  expense: ['read', 'create', 'update', 'delete'],

  /**
   * Support tickets. `update` covers replying: a reply is a change to the
   * ticket's state -- it is what stops its response clock.
   */
  ticket: ['read', 'create', 'update', 'delete'],
  /** Maintenance plans, what they include, and the visits performed under them. */
  maintenancePlan: ['read', 'create', 'update', 'delete'],
  /** Domains, hosting, servers, and everything else with a renewal date. */
  infrastructure: ['read', 'create', 'update', 'delete'],
  /** Documents filed against a client. */
  document: ['read', 'create', 'update', 'delete'],
  /** Recurring billing: the schedules that raise invoices on their own. */
  billingSchedule: ['read', 'create', 'update', 'delete'],

  /** The agency's own bank, card, and cash accounts. A setting more than daily work. */
  bankAccount: ['read', 'create', 'update', 'archive'],
  /**
   * Statement lines and the reconciliation desk. `reconcile` covers matching a
   * line, ignoring one, and closing off a statement period -- one permission,
   * because they are one job. Explaining a line as a new payment or expense
   * takes `payment:create` or `expense:create` instead: creating the record is
   * the stronger thing it does, and gating that behind a reconciliation
   * permission would be a quiet escalation.
   */
  bankTransaction: ['read', 'create', 'update', 'delete', 'import', 'reconcile'],

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
