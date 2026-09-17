'use client'

import { SearchIcon, cn } from '@workloom/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { NAV_ICONS } from '@/components/nav-icons'
import type { NavItem } from '@/components/app-shell'

/**
 * Jump to a section without reaching for the sidebar.
 *
 * It searches what this browser already knows -- the destinations the viewer
 * is allowed to open -- rather than pretending to search the agency's records:
 * a box that says "search" and quietly only looks at contacts is worse than no
 * box at all.
 */
export function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean
  onClose: () => void
  items: NavItem[]
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      inputRef.current?.focus()
    }
  }, [open])

  if (!open) return null

  const needle = query.trim().toLowerCase()
  const matches = needle ? items.filter((item) => item.label.toLowerCase().includes(needle)) : items
  const selected = matches[Math.min(index, matches.length - 1)]

  function go(item: NavItem | undefined) {
    if (!item) return
    onClose()
    router.push(item.href)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay p-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Jump to"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <SearchIcon className="text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setIndex((i) => Math.min(i + 1, matches.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setIndex((i) => Math.max(i - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                go(selected)
              } else if (event.key === 'Escape') {
                onClose()
              }
            }}
            placeholder="Jump to a section…"
            aria-label="Jump to a section"
            className="h-12 w-full bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
          />
        </div>
        <ul className="wl-scroll max-h-80 overflow-y-auto p-2">
          {matches.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Nothing matches.</li>}
          {matches.map((item, i) => {
            const Icon = NAV_ICONS[item.icon]
            const active = item === selected
            return (
              <li key={item.href}>
                <button
                  type="button"
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => go(item)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
                    active ? 'bg-selected text-ink' : 'text-muted hover:bg-hover',
                  )}
                >
                  <Icon className={cn('size-4', active ? 'text-accent' : 'text-faint')} />
                  {item.label}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
