'use client'

import { IconButton, MoonIcon, SunIcon } from '@workloom/ui'
import { useEffect, useState } from 'react'

const KEY = 'workloom-theme'

/**
 * Switches between the two themes.
 *
 * The choice lives in `localStorage` and is applied by the inline script in
 * the root layout, so this component only has to keep its own label honest --
 * it reads the attribute the script already set rather than deciding again.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  }, [])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // A blocked storage is not a reason to refuse the switch for this tab.
    }
    setTheme(next)
  }

  return (
    <IconButton
      label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
      size="icon-sm"
      onClick={toggle}
      className={className}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </IconButton>
  )
}
