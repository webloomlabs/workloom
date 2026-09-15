export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-12 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center text-sm font-semibold tracking-tight">Workloom</p>
        {children}
      </div>
    </main>
  )
}
