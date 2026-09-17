import { Button, Input } from '@workloom/ui'
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
        <label htmlFor="from" className="block text-xs font-medium text-neutral-500">From</label>
        <Input id="from" name="from" type="date" defaultValue={from} className="h-8" />
      </div>
      <div>
        <label htmlFor="to" className="block text-xs font-medium text-neutral-500">To</label>
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
    <nav aria-label="Period" className="flex items-center gap-1 rounded-md border border-neutral-200 p-0.5 dark:border-neutral-800">
      {options.map((option) => (
        <Link
          key={option.key}
          href={option.key === 'month' ? '/' : `/?period=${option.key}`}
          aria-current={option.key === active ? 'page' : undefined}
          className={`rounded px-2.5 py-1 text-xs font-medium ${
            option.key === active
              ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
              : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
          }`}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  )
}
