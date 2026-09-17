import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react'
import { cn } from './cn.ts'

const variants = {
  /** The one action a screen is for. There should rarely be two on a page. */
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover shadow-sm',
  /** Everything else with an outline: cancel, secondary navigation, filters. */
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-raised',
  /** Sits on a surface without drawing a box until it is pointed at. */
  ghost: 'text-muted hover:bg-hover hover:text-ink',
  /** A filled neutral, for toolbars where an outline would add too many lines. */
  subtle: 'bg-raised text-ink hover:bg-selected',
  /** Destructive, and it should look like it. */
  danger: 'bg-critical text-critical-ink hover:opacity-90',
} as const

const sizes = {
  xs: 'h-7 gap-1.5 rounded-md px-2 text-xs',
  sm: 'h-8 gap-1.5 rounded-md px-3 text-[13px]',
  md: 'h-9 gap-2 rounded-md px-3.5 text-sm',
  lg: 'h-10 gap-2 rounded-lg px-5 text-sm',
  /** Square, for a control whose whole content is one glyph. */
  icon: 'size-9 rounded-md',
  'icon-sm': 'size-8 rounded-md',
} as const

export type ButtonVariant = keyof typeof variants
export type ButtonSize = keyof typeof sizes

const base =
  'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ' +
  'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50'

/**
 * The button's classes on their own.
 *
 * Half this app's actions are navigations -- "New invoice" is a link, not a
 * form control -- and wrapping every `<Link>` in a button would be a lie to
 * assistive technology. So the styling is available without the element.
 */
export function buttonStyles({
  variant = 'primary',
  size = 'md',
  className,
}: {
  variant?: ButtonVariant | undefined
  size?: ButtonSize | undefined
  className?: string | undefined
} = {}) {
  return cn(base, variants[variant], sizes[size], className)
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({ variant, size, className, ...props }: ButtonProps) {
  return <button className={buttonStyles({ variant, size, className })} {...props} />
}

/** A button whose content is a single icon, so it has to name itself. */
export function IconButton({
  label,
  variant = 'ghost',
  size = 'icon',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  variant?: ButtonVariant
  size?: Extract<ButtonSize, 'icon' | 'icon-sm'>
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={buttonStyles({ variant, size, className })}
      {...props}
    />
  )
}

/** An external or download link that should read as a button. */
export function LinkButton({
  variant,
  size,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <a className={buttonStyles({ variant, size, className })} {...props} />
}
