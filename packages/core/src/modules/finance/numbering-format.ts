import { fiscalYearOf } from '../../reports/fiscal.ts'

/**
 * How a document number is printed, and which run of numbers it belongs to.
 *
 * Pure, so the settings screen can preview a format with the same code that
 * issues the real numbers.
 *
 * A format is a template: "WL-{YYYY}-{NNNN}" prints "WL-2026-0144". Tokens:
 *
 * - `{YYYY}`, `{YY}`: the year of the issue date;
 * - `{FY}`: the financial year the issue date falls in, "2025-26";
 * - `{N…}`: the counter, zero-padded to the number of Ns.
 */

export type SequenceReset = 'never' | 'yearly' | 'fiscal_yearly'

const TOKEN = /\{(YYYY|YY|FY|N+)\}/g
const COUNTER = /\{N+\}/
const YEAR = /\{(YYYY|YY|FY)\}/

export type FormatProblem = { code: string; message: string }

/** Why a format cannot be used with a reset rule, or null when it can. */
export function formatProblem(format: string, reset: SequenceReset): FormatProblem | null {
  if (format.length === 0 || format.length > 60) return { code: 'format_length', message: 'A number format is 1 to 60 characters.' }
  const counters = format.match(/\{N+\}/g) ?? []
  if (counters.length !== 1) return { code: 'format_counter', message: 'A number format needs exactly one counter, such as {NNNN}.' }
  if (counters[0]!.length - 2 > 12) return { code: 'format_counter', message: 'The counter can be at most 12 digits.' }
  const unknown = format.replace(TOKEN, '').match(/\{[^}]*\}/)
  if (unknown) return { code: 'format_token', message: `Unknown token ${unknown[0]}. Use {YYYY}, {YY}, {FY}, or {NNNN}.` }
  if (reset !== 'never' && !YEAR.test(format)) {
    return { code: 'format_year', message: 'A sequence that starts again each year must include the year -- {YYYY}, {YY} or {FY} -- or numbers would repeat.' }
  }
  if (reset === 'fiscal_yearly' && /\{(YYYY|YY)\}/.test(format) && !/\{FY\}/.test(format)) {
    // Allowed, but the calendar year printed is the issue date's, which can
    // repeat across two financial years. The scope keeps numbers unique only
    // if the printed year changes with it.
    return { code: 'format_year', message: 'A sequence that restarts each financial year must print the financial year, {FY}.' }
  }
  return null
}

/** The legacy format a prefix and padding stand for: "INV-" and 4 is "INV-{NNNN}". */
export function legacyFormat(prefix: string, padding: number): string {
  return `${prefix.replace(/[{}]/g, '')}{${'N'.repeat(padding)}}`
}

/** Prints a number. `issueDate` is YYYY-MM-DD. */
export function formatDocumentNumber(format: string, value: number, issueDate: string, fiscalStartMonth: number): string {
  if (!COUNTER.test(format)) throw new Error(`Number format "${format}" has no counter.`)
  const year = issueDate.slice(0, 4)
  return format.replace(TOKEN, (_, token: string) => {
    if (token === 'YYYY') return year
    if (token === 'YY') return year.slice(2)
    if (token === 'FY') return fiscalYearOf(issueDate, fiscalStartMonth).slug
    return String(value).padStart(token.length, '0')
  })
}

/** Which run of numbers a document issued on this date counts in. */
export function sequenceScope(reset: SequenceReset, issueDate: string, fiscalStartMonth: number): string {
  if (reset === 'yearly') return issueDate.slice(0, 4)
  if (reset === 'fiscal_yearly') return `FY${fiscalYearOf(issueDate, fiscalStartMonth).startYear}`
  return ''
}
