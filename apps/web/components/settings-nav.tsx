'use client'

import { cn } from '@workloom/ui'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function SettingsNav({ items }: { items: Array<{ href: string; label: string }> }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm',
              active
                ? 'border-neutral-900 font-medium text-neutral-900 dark:border-neutral-100 dark:text-neutral-100'
                : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200',
            )}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
