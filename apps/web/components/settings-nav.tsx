'use client'

import { tabStyles } from '@workloom/ui'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function SettingsNav({ items }: { items: Array<{ href: string; label: string }> }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Settings" className="wl-scroll flex gap-1 overflow-x-auto border-b border-line">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
        return (
          <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined} className={tabStyles(active)}>
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
