/**
 * The centred, chrome-free frame the signed-out screens share.
 *
 * Its own component rather than a layout because setup sits outside the
 * `(auth)` route group -- that group redirects to setup, and a page cannot
 * redirect to itself.
 */
export function AuthShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-12 dark:bg-neutral-950">
      <div className={wide ? 'w-full max-w-md' : 'w-full max-w-sm'}>
        <p className="mb-8 text-center text-sm font-semibold tracking-tight">Workloom</p>
        {children}
      </div>
    </main>
  )
}
