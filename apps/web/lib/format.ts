/**
 * Dates for display, in the organization's time zone -- not the server's,
 * which in a container is usually UTC.
 */

export function formatDate(value: Date | string | null | undefined, timeZone?: string): string {
  if (!value) return '—'
  // A bare `YYYY-MM-DD` is a calendar date, not an instant: format it as-is so
  // no time zone can move it to the previous or next day.
  if (typeof value === 'string') {
    return new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`))
  }
  return new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeZone }).format(value)
}

export function formatDateTime(value: Date | null | undefined, timeZone?: string): string {
  return value ? new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(value) : '—'
}
