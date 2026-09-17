import { cn } from '@workloom/ui'

/**
 * The centred, chrome-free frame the signed-out screens share.
 *
 * Its own component rather than a layout because setup sits outside the
 * `(auth)` route group -- that group redirects to setup, and a page cannot
 * redirect to itself.
 */
export function AuthShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-4 py-12">
      {/* A single wash of the accent, so the sign-in screen is not a grey box. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-accent-soft blur-3xl"
      />
      <div className={cn('relative w-full', wide ? 'max-w-md' : 'max-w-sm')}>
        <div className="mb-8 flex items-center justify-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-sm font-bold text-accent-ink">
            W
          </span>
          <span className="text-sm font-semibold tracking-tight text-ink">Workloom</span>
        </div>
        {children}
      </div>
    </main>
  )
}
