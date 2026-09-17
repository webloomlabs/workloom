import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from './cn.ts'
import { AlertIcon, CheckCircleIcon, InfoIcon } from './icon.tsx'

/** The panel everything sits on: one hairline, one radius, one background. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('overflow-hidden rounded-xl border border-line bg-surface shadow-sm', className)}
      {...props}
    />
  )
}

export function CardHeader({
  title,
  description,
  action,
  icon,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-line px-5 py-3.5">
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && <span className="mt-0.5 text-muted">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  )
}

/** Padding for card content that is not a table or a list. */
export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-3 border-t border-line px-5 py-3', className)}
      {...props}
    />
  )
}

const alertTones = {
  error: { box: 'border-critical/30 bg-critical-soft text-critical', Icon: AlertIcon },
  success: { box: 'border-positive/30 bg-positive-soft text-positive', Icon: CheckCircleIcon },
  info: { box: 'border-line bg-raised text-muted', Icon: InfoIcon },
  warning: { box: 'border-caution/30 bg-caution-soft text-caution', Icon: AlertIcon },
} as const

export type AlertTone = keyof typeof alertTones

export function Alert({
  tone = 'info',
  children,
  className,
}: {
  tone?: AlertTone
  children: ReactNode
  className?: string
}) {
  const { box, Icon } = alertTones[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm', box, className)}
    >
      <Icon className="mt-0.5" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function EmptyState({
  children,
  icon,
  action,
}: {
  children: ReactNode
  icon?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
      {icon && (
        <span className="flex size-10 items-center justify-center rounded-full bg-raised text-faint">
          {icon}
        </span>
      )}
      <p className="text-sm text-muted">{children}</p>
      {action}
    </div>
  )
}

export function Separator({ className }: { className?: string }) {
  return <hr className={cn('border-0 border-t border-line', className)} />
}
