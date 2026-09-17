import { Button, Input, pillStyles } from '@workloom/ui'
import Link from 'next/link'

/**
 * The period a report covers.
 *
 * A plain GET form, so it works without JavaScript and every period is a URL
 * someone can send to a colleague.
 */
export function PeriodPicker({ from, to }: { from: string; to: string }) {
  return (
    <form action="/reports" className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="from" className="mb-1 block text-xs font-medium text-muted">From</label>
        <Input id="from" name="from" type="date" defaultValue={from} className="h-8" />
      </div>
      <div>
        <label htmlFor="to" className="mb-1 block text-xs font-medium text-muted">To</label>
        <Input id="to" name="to" type="date" defaultValue={to} className="h-8" />
      </div>
      <Button type="submit" size="sm" variant="secondary">Show</Button>
    </form>
  )
}

/** The span the dashboard covers. Plain links, so every period is a shareable URL. */
export function PeriodTabs({ active }: { active: 'month' | 'quarter' | 'year' }) {
  const options = [
    { key: 'month', label: 'This month' },
    { key: 'quarter', label: 'This quarter' },
    { key: 'year', label: 'This year' },
  ] as const
  return (
    <nav aria-label="Period" className="flex items-center gap-0.5 rounded-full bg-raised p-0.5">
      {options.map((option) => (
        <Link
          key={option.key}
          href={option.key === 'month' ? '/' : `/?period=${option.key}`}
          aria-current={option.key === active ? 'page' : undefined}
          className={pillStyles(option.key === active, 'text-xs')}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  )
}
