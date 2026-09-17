import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { cn } from './cn.ts'
import { ChevronDownIcon, SearchIcon } from './icon.tsx'

/** Every text control is the same control; only the element differs. */
export const controlStyles =
  'block w-full rounded-md border border-line-strong bg-inset px-3 text-sm text-ink ' +
  'placeholder:text-faint transition-colors ' +
  'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent ' +
  'aria-invalid:border-critical aria-invalid:focus:ring-critical ' +
  'disabled:cursor-not-allowed disabled:opacity-60'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlStyles, 'h-9', className)} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(controlStyles, 'min-h-20 py-2 leading-6', className)} {...props} />
}

/**
 * A native select, with the platform arrow replaced by ours.
 *
 * Native because a listbox rebuilt in React loses type-ahead, mobile pickers
 * and form submission without JavaScript -- all of which this app relies on.
 */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select className={cn(controlStyles, 'h-9 appearance-none pr-8', className)} {...props} />
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
    </span>
  )
}

/** A search input with the magnifier inside it. */
export function SearchInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className="relative block">
      <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
      <input
        type="search"
        className={cn(controlStyles, 'h-8 bg-raised pl-8 [&::-webkit-search-cancel-button]:appearance-none', className)}
        {...props}
      />
    </span>
  )
}

export function Checkbox({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        'size-4 shrink-0 rounded border-line-strong bg-inset text-accent',
        'accent-[var(--wl-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        className,
      )}
      {...props}
    />
  )
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('block text-sm font-medium text-ink', className)} {...props} />
}

/**
 * Label, control, hint and error, wired together for assistive technology:
 * the error is announced and linked to the control by id, so it is not only a
 * red line of text that a screen reader never mentions.
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  hint?: ReactNode
  error?: string | undefined
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-critical">
          {error}
        </p>
      )}
    </div>
  )
}
