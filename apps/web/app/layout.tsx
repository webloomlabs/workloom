import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Workloom',
  description: 'An operating system for digital agencies',
}

export const viewport: Viewport = {
  // Matches the two canvases, so the browser chrome does not flash white.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#100f0e' },
    { media: '(prefers-color-scheme: light)', color: '#f6f6f3' },
  ],
}

/**
 * Applies the stored theme before the first paint.
 *
 * Dark is the product's own theme, not a concession to the operating system,
 * so it stays until someone asks for light. Without this line running ahead of
 * the body, a light-theme visitor gets a dark flash on every full page load.
 * It fails closed: any error leaves the dark default in place.
 */
const themeScript = `try{var t=localStorage.getItem('workloom-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">{children}</body>
    </html>
  )
}
