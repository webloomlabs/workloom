import { tabStyles } from '@workloom/ui'
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
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-line">
      <nav aria-label={label} className="wl-scroll -mb-px flex gap-1 overflow-x-auto">
        {available.map((tab) => {
          const current = tab.key === active
          return (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={current ? 'page' : undefined}
              className={tabStyles(current)}
            >
              {tab.label}
              {typeof tab.count === 'number' && <span className="rounded-full bg-raised px-1.5 py-0.5 text-[11px] tabular-nums text-muted">{tab.count}</span>}
            </Link>
          )
        })}
      </nav>
      {unavailable.length > 0 && (
        <ul aria-label="Not yet available" className="hidden flex-wrap sm:flex gap-x-3 gap-y-1 pb-2 text-xs text-faint">
          {unavailable.map((tab) => (
            <li key={tab.key} aria-disabled="true" title={unavailableNote[tab.status as 'upcoming' | 'planned']}>
              {tab.label}
              <span className="ml-1 rounded bg-raised px-1 py-px text-[10px] uppercase tracking-wide text-faint">
                {tab.status === 'upcoming' ? 'Soon' : 'Planned'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
