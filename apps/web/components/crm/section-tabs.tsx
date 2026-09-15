import { cn } from '@workloom/ui'
import Link from 'next/link'

export type SectionTab = {
  key: string
  label: string
  href: string
  count?: number | null | undefined
  /** `upcoming` and `planned` tabs are shown, so people can see where things will go, but cannot be opened. */
  status: 'available' | 'upcoming' | 'planned'
}

const unavailableNote = { upcoming: 'Coming in a later release', planned: 'Planned for after the first release' } as const

/**
 * Tabs for a record's sections. Available tabs are links, so each section has
 * its own URL; the rest are inert labels that explain themselves on hover.
 */
export function SectionTabs({ tabs, active, label }: { tabs: SectionTab[]; active: string; label: string }) {
  const available = tabs.filter((t) => t.status === 'available')
  const unavailable = tabs.filter((t) => t.status !== 'available')

  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-neutral-200 dark:border-neutral-800">
      <nav aria-label={label} className="-mb-px flex gap-1 overflow-x-auto">
        {available.map((tab) => {
          const current = tab.key === active
          return (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap border-b-2 px-3 py-2 text-sm',
                current
                  ? 'border-neutral-900 font-medium text-neutral-900 dark:border-neutral-100 dark:text-neutral-100'
                  : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200',
              )}
            >
              {tab.label}
              {typeof tab.count === 'number' && <span className="ml-1.5 text-xs tabular-nums text-neutral-400">{tab.count}</span>}
            </Link>
          )
        })}
      </nav>
      {unavailable.length > 0 && (
        <ul aria-label="Not yet available" className="hidden flex-wrap sm:flex gap-x-3 gap-y-1 pb-2 text-xs text-neutral-400">
          {unavailable.map((tab) => (
            <li key={tab.key} aria-disabled="true" title={unavailableNote[tab.status as 'upcoming' | 'planned']}>
              {tab.label}
              <span className="ml-1 rounded bg-neutral-100 px-1 py-px text-[10px] uppercase tracking-wide dark:bg-neutral-800">
                {tab.status === 'upcoming' ? 'Soon' : 'Planned'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
