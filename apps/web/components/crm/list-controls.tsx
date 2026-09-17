import { SearchInput, buttonStyles, pillStyles } from '@workloom/ui'
import Link from 'next/link'

/** Filter tabs that are plain links, so a filtered list can be bookmarked and shared. */
export function FilterTabs({ tabs, active }: { tabs: Array<{ href: string; label: string; key: string }>; active: string }) {
  return (
    <nav aria-label="Filter" className="flex flex-wrap items-center gap-0.5 rounded-full bg-raised p-0.5">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? 'page' : undefined}
          className={pillStyles(tab.key === active)}
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
      <SearchInput id="q" name="q" defaultValue={q} placeholder={placeholder} className="w-56" />
      <button type="submit" className={buttonStyles({ variant: 'secondary', size: 'sm' })}>Search</button>
    </form>
  )
}

export function Pager({ base, params, cursor, nextCursor }: { base: string; params: Record<string, string>; cursor?: string | undefined; nextCursor: string | null }) {
  if (!cursor && !nextCursor) return null
  const href = (extra: Record<string, string>) => `${base}?${new URLSearchParams({ ...params, ...extra })}`
  return (
    <div className="flex justify-between border-t border-line px-5 py-3 text-sm text-muted">
      {cursor ? <Link href={href({})} className="hover:text-ink">← Newest</Link> : <span />}
      {nextCursor && <Link href={href({ cursor: nextCursor })} className="hover:text-ink">Older →</Link>}
    </div>
  )
}

/** Reads one string search param. */
export function param(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
