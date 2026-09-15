'use client'

import { cn } from '@workloom/ui'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function MainNav({ items }: { items: Array<{ href: string; label: string; match?: string[] | undefined }> }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto">
      {items.map((item) => {
        const active = [item.href, ...(item.match ?? [])].some(
          (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
        )
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm',
              active
                ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
            )}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
