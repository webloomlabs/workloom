import { z } from 'zod'
import { DomainError, type ActorContext } from '../context.ts'
import { minorToDecimalString } from '../money/currency.ts'
import { defineProcedure } from '../registry/index.ts'
import type { Permission } from '../permissions/index.ts'
import { companyList, contactList, dealList, leadList } from './crm/index.ts'
import { expenseList, invoiceList, paymentList } from './finance/index.ts'
import { projectList, taskList } from './projects/index.ts'
import { timeEntryList } from './time/index.ts'

/**
 * Getting the data out.
 *
 * Nobody should have to ask for their own records back, so every collection an
 * agency would want is exportable, over the same API and under the same
 * permission as reading it.
 *
 * **The columns are named, not reflected.** A CSV someone has built a
 * spreadsheet around is a contract: if the columns moved because a developer
 * renamed a field, that spreadsheet breaks silently in a month. Naming them
 * here makes a change to one a decision, and a test asserts the header lines.
 *
 * Exports read through the list procedures rather than their own queries, so
 * what comes out is exactly what the API shows -- including every tenant and
 * visibility rule those already apply.
 */

/** A page at a time, up to this many rows. Beyond it, filter or use the API. */
const MAX_ROWS = 10_000
const PAGE = 200

type Listable = {
  permission: Permission
  /** A list procedure, paged through in full. */
  list: { handler: (ctx: ActorContext, input: never) => Promise<{ data: unknown[]; nextCursor: string | null }> }
  /** Extra input the list takes, beyond paging. */
  input?: Record<string, unknown>
  columns: readonly string[]
}

const catalogue = {
  companies: {
    permission: 'company:read',
    list: companyList,
    input: { includeArchived: true },
    columns: ['id', 'name', 'lifecycleStage', 'email', 'phone', 'website', 'city', 'country', 'archivedAt', 'createdAt'],
  },
  contacts: {
    permission: 'contact:read',
    list: contactList,
    input: { includeArchived: true },
    columns: ['id', 'firstName', 'lastName', 'email', 'phone', 'title', 'companyId', 'companyName', 'archivedAt', 'createdAt'],
  },
  leads: {
    permission: 'lead:read',
    list: leadList,
    input: { includeArchived: true },
    columns: ['id', 'contactName', 'companyName', 'email', 'phone', 'source', 'status', 'convertedAt', 'createdAt'],
  },
  deals: {
    permission: 'deal:read',
    list: dealList,
    input: { includeArchived: true },
    columns: ['id', 'name', 'companyId', 'companyName', 'stage', 'currency', 'valueMinor', 'expectedCloseDate', 'closedAt', 'createdAt'],
  },
  projects: {
    permission: 'project:read',
    list: projectList,
    input: { includeArchived: true },
    columns: ['id', 'name', 'companyId', 'companyName', 'status', 'startDate', 'dueDate', 'currency', 'budgetMinor', 'completedAt', 'createdAt'],
  },
  tasks: {
    permission: 'task:read',
    list: taskList,
    columns: ['id', 'title', 'projectId', 'projectName', 'status', 'priority', 'assigneeName', 'dueDate', 'estimateMinutes', 'completedAt', 'createdAt'],
  },
  'time-entries': {
    permission: 'timeEntry:read',
    list: timeEntryList,
    columns: [
      'id', 'spentOn', 'userName', 'projectId', 'projectName', 'taskTitle', 'description',
      'durationSeconds', 'billable', 'invoiced', 'currency', 'billableRateMinor', 'costRateMinor',
    ],
  },
  invoices: {
    permission: 'invoice:read',
    list: invoiceList,
    columns: [
      'id', 'number', 'companyId', 'companyName', 'status', 'issueDate', 'dueDate', 'currency',
      'subtotalMinor', 'discountMinor', 'taxMinor', 'totalMinor', 'amountPaidMinor', 'amountDueMinor',
    ],
  },
  payments: {
    permission: 'payment:read',
    list: paymentList,
    columns: ['id', 'receivedOn', 'companyId', 'companyName', 'kind', 'method', 'reference', 'currency', 'amountMinor', 'allocatedMinor', 'unallocatedMinor'],
  },
  expenses: {
    permission: 'expense:read',
    list: expenseList,
    columns: [
      'id', 'incurredOn', 'description', 'supplier', 'category', 'projectId', 'projectName',
      'companyId', 'companyName', 'currency', 'amountMinor', 'taxMinor', 'billable', 'invoiceNumber',
    ],
  },
} as const satisfies Record<string, Listable>

export type ExportResource = keyof typeof catalogue
export const EXPORT_RESOURCES = Object.keys(catalogue) as ExportResource[]

/**
 * The header a column appears under.
 *
 * Amounts are stored in minor units, which is right in a database and wrong in
 * a spreadsheet: nobody wants to divide a column by 100 before they can sum it.
 * A `…Minor` column is written as a decimal in the row's own currency, under
 * the name without the suffix.
 */
export function headerFor(column: string): string {
  return column.endsWith('Minor') ? column.slice(0, -'Minor'.length) : column
}

function cellFor(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  if (value === null || value === undefined) return ''
  if (column.endsWith('Minor') && typeof value === 'number') {
    const currency = typeof row.currency === 'string' ? row.currency : null
    // Without a currency there is no exponent to divide by, so the raw figure
    // goes out rather than a wrong one.
    return currency ? minorToDecimalString(value, currency) : String(value)
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/**
 * One CSV field.
 *
 * Quoted whenever it contains a delimiter, a quote, or a newline, with inner
 * quotes doubled -- RFC 4180. A leading `=`, `+`, `-` or `@` is prefixed with a
 * single quote: spreadsheets treat those as formulas, and a field from an
 * untrusted lead form would otherwise execute when the file is opened.
 */
export function csvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function toCsv(columns: readonly string[], rows: Array<Record<string, unknown>>): string {
  const lines = [columns.map((c) => csvField(headerFor(c))).join(',')]
  for (const row of rows) lines.push(columns.map((c) => csvField(cellFor(row, c))).join(','))
  // A trailing newline: some tools drop the last line without one.
  return `${lines.join('\r\n')}\r\n`
}

export type ExportResult = { resource: ExportResource; columns: string[]; rows: Array<Record<string, unknown>>; truncated: boolean }

export function isExportResource(value: string): value is ExportResource {
  return Object.hasOwn(catalogue, value)
}

/**
 * Every row of one collection, projected onto its named columns.
 *
 * Pages through the list procedure rather than querying: the export then
 * inherits every filter, join, and permission-dependent redaction the API
 * already applies, and cannot drift from it.
 */
export async function collectExport(ctx: ActorContext, resource: ExportResource): Promise<ExportResult> {
  const entry = catalogue[resource] as Listable
  ctx.require(entry.permission)

  const rows: Array<Record<string, unknown>> = []
  let cursor: string | null = null
  let truncated = false

  for (;;) {
    const page = await entry.list.handler(ctx, {
      ...entry.input,
      limit: PAGE,
      ...(cursor ? { cursor } : {}),
    } as never)
    for (const row of page.data as Array<Record<string, unknown>>) {
      if (rows.length >= MAX_ROWS) {
        truncated = true
        break
      }
      rows.push(row)
    }
    cursor = page.nextCursor
    if (!cursor || truncated) break
  }

  return { resource, columns: [...entry.columns], rows, truncated }
}

export const exportRun = defineProcedure({
  name: 'export.run',
  summary: 'Every row of one collection, as JSON. The same URL with .csv returns a spreadsheet.',
  /**
   * The gate is the resource's own read permission, applied in the handler,
   * because which resource it is arrives in the input. Declaring anything
   * static here would be worse in both directions: a permission every role has
   * says nothing, and one they do not would lock out a role that may read the
   * collection perfectly well. It also keeps the story simple for an API key --
   * to export projects, scope it to `project:read`.
   */
  permission: 'authenticated',
  readOnly: true,
  input: z.object({ resource: z.enum(EXPORT_RESOURCES as [ExportResource, ...ExportResource[]]) }),
  output: z.object({
    resource: z.string(),
    /** The fields of each row, in the order a CSV writes them. */
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
    /** True when the export hit its row limit and there is more to fetch. */
    truncated: z.boolean(),
  }),
  http: { method: 'GET', path: '/exports/{resource}' },
  rateLimit: 'expensive',
  async handler(ctx, input) {
    // The column names are the row keys, unchanged: a JSON consumer indexes by
    // them. The CSV transport is what renames `totalMinor` to `total`.
    return collectExport(ctx, input.resource)
  },
})

/** The filename a browser should save an export under. */
export function exportFilename(resource: ExportResource, on: string): string {
  return `workloom-${resource}-${on}.csv`
}

/** Refuses a resource that is not in the catalogue, with the list of what is. */
export function requireExportResource(value: string): ExportResource {
  if (!isExportResource(value)) {
    throw new DomainError(`No such export. Try one of: ${EXPORT_RESOURCES.join(', ')}.`, 'unknown_export', 'resource')
  }
  return value
}
