import type { ReactNode } from 'react'
import { cn, type ClassValue } from './cn.ts'

/**
 * The title block every page opens with.
 *
 * One shape for all of them, so "what am I looking at" and "what can I do
 * here" are always in the same two places.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  eyebrow,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  breadcrumb?: ReactNode
  eyebrow?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 space-y-1">
        {breadcrumb}
        {eyebrow && (
          <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">{eyebrow}</p>
        )}
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {/* A div, not a paragraph: a description often carries badges and a
            progress bar, which a paragraph cannot legally contain. */}
        {description && <div className="max-w-3xl text-sm text-muted">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** A row of controls above or beside a list: filters, search, view switches. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>
}

/**
 * Tab classes, not a tab component.
 *
 * Every tab strip in this app is a set of links -- a filtered list is a URL
 * someone can send to a colleague -- so what is shared is the appearance.
 */
export function tabStyles(active: boolean, className?: ClassValue) {
  return cn(
    '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors',
    active
      ? 'border-accent font-semibold text-ink'
      : 'border-transparent text-muted hover:border-line-strong hover:text-ink',
    className,
  )
}

/** A filter chip: the same idea, drawn as a pill. */
export function pillStyles(active: boolean, className?: ClassValue) {
  return cn(
    'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-[13px] transition-colors',
    active
      ? 'bg-accent text-accent-ink font-medium'
      : 'text-muted hover:bg-hover hover:text-ink',
    className,
  )
}

/** A sidebar row: section links, and the settings tabs on narrow screens. */
export function navItemStyles(active: boolean, className?: ClassValue) {
  return cn(
    'group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
    active
      ? 'bg-selected font-medium text-ink'
      : 'text-muted hover:bg-hover hover:text-ink',
    className,
  )
}

/** A dotted box standing in for content that does not exist yet. */
export function Placeholder({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-xs text-faint',
        className,
      )}
    >
      {children}
    </p>
  )
}
