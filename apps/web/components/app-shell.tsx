'use client'

import {
  ChevronDownIcon,
  IconButton,
  MenuIcon,
  PanelLeftIcon,
  SearchIcon,
  XIcon,
  cn,
  navItemStyles,
} from '@workloom/ui'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { CommandPalette } from '@/components/command-palette'
import { NAV_ICONS, type NavIconName } from '@/components/nav-icons'

export type NavItem = {
  href: string
  label: string
  icon: NavIconName
  /** Extra path prefixes that should light this item up. */
  match?: string[] | undefined
}

export type NavGroup = { key: string; label: string; items: NavItem[] }

const RAIL_KEY = 'workloom-sidebar-collapsed'
const GROUPS_KEY = 'workloom-sidebar-groups'

function isActive(pathname: string, item: NavItem) {
  return [item.href, ...(item.match ?? [])].some(
    (prefix) => pathname === prefix || (prefix !== '/' && pathname.startsWith(`${prefix}/`)),
  )
}

/**
 * The signed-in frame: a sidebar of sections, a top bar, and the page.
 *
 * It is one client component rather than three because the three of them share
 * state -- the drawer a narrow screen opens, and the rail a wide one collapses
 * to. Everything that needs the server (the organization switcher, the running
 * timer, the sign-out form) is passed in already rendered.
 */
export function AppShell({
  groups,
  settingsHref,
  brand,
  orgSwitcher,
  timer,
  user,
  utilities,
  children,
}: {
  groups: NavGroup[]
  settingsHref?: string | undefined
  brand: string
  orgSwitcher?: React.ReactNode
  timer?: React.ReactNode
  user: { name: string; email: string }
  utilities?: React.ReactNode
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [drawer, setDrawer] = useState(false)
  const [rail, setRail] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [palette, setPalette] = useState(false)

  // Restore what this browser last chose. Reading in an effect rather than
  // during render keeps the server and the first client pass identical.
  useEffect(() => {
    try {
      setRail(localStorage.getItem(RAIL_KEY) === '1')
      const stored = localStorage.getItem(GROUPS_KEY)
      if (stored) setCollapsed(JSON.parse(stored) as Record<string, boolean>)
    } catch {
      // No stored preference is simply the default one.
    }
  }, [])

  // A navigation is what closes the drawer; leaving it open over the new page
  // would cover it.
  useEffect(() => setDrawer(false), [pathname])

  const toggleRail = useCallback(() => {
    setRail((value) => {
      const next = !value
      try {
        localStorage.setItem(RAIL_KEY, next ? '1' : '0')
      } catch {
        /* preference only */
      }
      return next
    })
  }, [])

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = { ...current, [key]: !current[key] }
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify(next))
      } catch {
        /* preference only */
      }
      return next
    })
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPalette(true)
      }
      if (event.key === 'Escape') setDrawer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const items = groups.flatMap((group) => group.items)

  return (
    <div className="flex min-h-screen bg-canvas">
      {drawer && (
        <button
          type="button"
          aria-label="Close the navigation"
          onClick={() => setDrawer(false)}
          className="fixed inset-0 z-30 bg-overlay lg:hidden"
        />
      )}

      <aside
        className={cn(
          'wl-scroll fixed inset-y-0 left-0 z-40 flex shrink-0 flex-col border-r border-line bg-surface transition-[width,transform] duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          rail ? 'w-[4.25rem]' : 'w-64',
          drawer ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className={cn('flex h-14 shrink-0 items-center gap-2 px-3', rail && 'justify-center px-0')}>
          <Link
            href="/"
            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-sm font-semibold tracking-tight text-ink"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-[13px] font-bold text-accent-ink">
              {brand.slice(0, 1)}
            </span>
            {!rail && <span className="truncate">{brand}</span>}
          </Link>
          {!rail && (
            <IconButton
              label="Collapse the sidebar"
              size="icon-sm"
              className="ml-auto hidden lg:inline-flex"
              onClick={toggleRail}
            >
              <PanelLeftIcon />
            </IconButton>
          )}
          <IconButton
            label="Close the navigation"
            size="icon-sm"
            className="ml-auto lg:hidden"
            onClick={() => setDrawer(false)}
          >
            <XIcon />
          </IconButton>
        </div>

        {rail && (
          <IconButton
            label="Expand the sidebar"
            size="icon-sm"
            className="mx-auto mb-1 hidden lg:inline-flex"
            onClick={toggleRail}
          >
            <PanelLeftIcon />
          </IconButton>
        )}

        {orgSwitcher && !rail && <div className="px-3 pb-2">{orgSwitcher}</div>}

        <nav aria-label="Main" className="wl-scroll flex-1 overflow-y-auto px-2 pb-4">
          {groups.map((group) => {
            const shut = collapsed[group.key] === true && !rail
            return (
              <div key={group.key} className="mb-1">
                {group.label && !rail && (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={!shut}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-faint transition-colors hover:text-muted"
                  >
                    {group.label}
                    <ChevronDownIcon className={cn('size-3.5 transition-transform', shut && '-rotate-90')} />
                  </button>
                )}
                {group.label && rail && <div className="mx-auto my-2 h-px w-6 bg-line" />}
                {!shut && (
                  <ul className="space-y-0.5">
                    {group.items.map((item) => {
                      const Icon = NAV_ICONS[item.icon]
                      const active = isActive(pathname, item)
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            aria-current={active ? 'page' : undefined}
                            title={rail ? item.label : undefined}
                            className={navItemStyles(active, rail && 'justify-center px-0 py-2')}
                          >
                            <Icon className={cn('size-4', active ? 'text-accent' : 'text-faint group-hover:text-muted')} />
                            {!rail && <span className="truncate">{item.label}</span>}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })}
        </nav>

        {settingsHref && (
          <div className="border-t border-line p-2">
            <Link
              href={settingsHref}
              title={rail ? 'Settings' : undefined}
              className={navItemStyles(
                pathname.startsWith('/settings'),
                rail && 'justify-center px-0 py-2',
              )}
            >
              <NAV_ICONS.settings className="size-4 text-faint" />
              {!rail && <span>Settings</span>}
            </Link>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-canvas/85 px-4 backdrop-blur">
          <IconButton label="Open the navigation" className="lg:hidden" onClick={() => setDrawer(true)}>
            <MenuIcon />
          </IconButton>

          <button
            type="button"
            onClick={() => setPalette(true)}
            className="flex h-9 w-full max-w-xl items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm text-faint transition-colors hover:border-line-strong hover:text-muted"
          >
            <SearchIcon />
            <span className="truncate">Jump to a section or action</span>
            <span className="ml-auto hidden items-center gap-1 text-[11px] sm:flex">
              <kbd className="rounded border border-line-strong bg-raised px-1.5 py-0.5 font-sans">⌘</kbd>
              <kbd className="rounded border border-line-strong bg-raised px-1.5 py-0.5 font-sans">K</kbd>
            </span>
          </button>

          <div className="ml-auto flex items-center gap-1.5">
            {timer}
            {utilities}
            <span className="hidden max-w-48 truncate text-xs text-muted xl:inline" title={user.email}>
              {user.email}
            </span>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} items={items} />
    </div>
  )
}
