import { cn } from '@workloom/ui'
import Link from 'next/link'

/** Filter tabs that are plain links, so a filtered list can be bookmarked and shared. */
export function FilterTabs({ tabs, active }: { tabs: Array<{ href: string; label: string; key: string }>; active: string }) {
  return (
    <nav aria-label="Filter" className="flex flex-wrap gap-1">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? 'page' : undefined}
          className={cn(
            'rounded-md px-2.5 py-1 text-sm',
            tab.key === active
              ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
              : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}

/** A GET search form: the query lives in the URL, and works without JavaScript. */
export function SearchBox({ action, q, hidden = {}, placeholder }: { action: string; q?: string | undefined; hidden?: Record<string, string>; placeholder: string }) {
  return (
    <form action={action} role="search" className="flex gap-2">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label htmlFor="q" className="sr-only">Search</label>
      <input
        id="q"
        name="q"
        type="search"
        defaultValue={q}
        placeholder={placeholder}
        className="h-8 w-56 rounded-md border border-neutral-300 bg-white px-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
      <button type="submit" className="h-8 rounded-md border border-neutral-300 px-3 text-sm dark:border-neutral-700">Search</button>
    </form>
  )
}

export function Pager({ base, params, cursor, nextCursor }: { base: string; params: Record<string, string>; cursor?: string | undefined; nextCursor: string | null }) {
  if (!cursor && !nextCursor) return null
  const href = (extra: Record<string, string>) => `${base}?${new URLSearchParams({ ...params, ...extra })}`
  return (
    <div className="flex justify-between px-5 py-3 text-sm">
      {cursor ? <Link href={href({})} className="hover:underline">← Newest</Link> : <span />}
      {nextCursor && <Link href={href({ cursor: nextCursor })} className="hover:underline">Older →</Link>}
    </div>
  )
}

/** Reads one string search param. */
export function param(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
