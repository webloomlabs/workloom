import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from './cn.ts'

/**
 * A table that scrolls inside its own container instead of widening the page.
 *
 * `relative` matters: without a positioned container, absolutely positioned
 * cells' contents -- screen-reader-only labels -- escape the scroll area and
 * widen the page anyway.
 */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('wl-scroll relative overflow-x-auto', className)}>
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  )
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'border-b border-line bg-surface px-5 py-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-faint',
        className,
      )}
    >
      {children}
    </th>
  )
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn('border-b border-line px-5 py-3 align-middle text-ink', className)}>{children}</td>
}

/** A body row. Rows highlight on hover, so a wide row stays readable across. */
export function Tr({ children, className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn('transition-colors hover:bg-hover', className)} {...props}>
      {children}
    </tr>
  )
}

const badgeTones = {
  neutral: 'bg-raised text-muted ring-line',
  accent: 'bg-accent-soft text-accent-text ring-accent/25',
  positive: 'bg-positive-soft text-positive ring-positive/25',
  caution: 'bg-caution-soft text-caution ring-caution/25',
  critical: 'bg-critical-soft text-critical ring-critical/25',
  info: 'bg-info-soft text-info ring-info/25',
} as const

export type BadgeTone = keyof typeof badgeTones

/**
 * A status word.
 *
 * `dot` draws the small disc the reference UI puts before a priority, for the
 * cases where the colour is the point and the word is the label.
 */
export function Badge({
  tone = 'neutral',
  dot = false,
  children,
  className,
}: {
  tone?: BadgeTone
  dot?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        badgeTones[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

/** Initials in a disc, for a person or an organization. */
export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
  const sizes = { sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-10 text-sm' }
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold uppercase text-accent-text ring-1 ring-inset ring-accent/20',
        sizes[size],
        className,
      )}
    >
      {initials || '?'}
    </span>
  )
}

/**
 * One figure, its label, and how it moved.
 *
 * `invert` is for the figures where up is bad: spending more is not an
 * improvement, and colouring it green because the arrow points up would be
 * actively misleading.
 */
export function Stat({
  label,
  value,
  detail,
  change,
  invert,
  tone,
  className,
}: {
  label: ReactNode
  value: ReactNode
  detail?: ReactNode
  change?: string | null | undefined
  invert?: boolean | undefined
  tone?: 'critical' | undefined
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">{label}</div>
      <div
        className={cn(
          'text-2xl font-semibold tracking-tight tabular-nums',
          tone === 'critical' ? 'text-critical' : 'text-ink',
        )}
      >
        {value}
      </div>
      <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted">
        {change != null && <Delta percent={change} invert={invert} />}
        {detail && <span>{detail}</span>}
      </div>
    </div>
  )
}

export function Delta({ percent, invert }: { percent: string; invert?: boolean | undefined }) {
  const value = Number(percent)
  const flat = value === 0
  const good = invert ? value < 0 : value > 0
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1 py-px font-medium tabular-nums',
        flat ? 'text-muted' : good ? 'bg-positive-soft text-positive' : 'bg-critical-soft text-critical',
      )}
    >
      {value > 0 ? '↑' : value < 0 ? '↓' : '·'} {Math.abs(value)}%
    </span>
  )
}

/** A proportion, drawn. Used for budgets, progress and utilisation. */
export function Meter({
  value,
  max = 100,
  tone = 'accent',
  label,
}: {
  value: number
  max?: number
  tone?: 'accent' | 'positive' | 'caution' | 'critical'
  label?: string
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  const fills = {
    accent: 'bg-accent',
    positive: 'bg-positive',
    caution: 'bg-caution',
    critical: 'bg-critical',
  }
  return (
    <span
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="block h-1.5 w-full overflow-hidden rounded-full bg-raised"
    >
      <span className={cn('block h-full rounded-full', fills[tone])} style={{ width: `${pct}%` }} />
    </span>
  )
}

/** A keyboard hint, as in the search field's ⌘K. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-raised px-1.5 py-0.5 font-sans text-[10px] font-medium text-faint">
      {children}
    </kbd>
  )
}
