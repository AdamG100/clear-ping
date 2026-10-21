'use client'

import { useCallback, useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

/**
 * The theme on screen, and a way to change it.
 *
 * Which theme is in force is the `data-theme` on <html>, set before first
 * paint by the script in layout.tsx from what was chosen last time or, failing
 * that, the system's setting. This reads it from there and writes it back
 * there, so the page, Arc's components and that script always agree.
 */

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

const current = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')

export function useTheme(): [Theme, (next: Theme) => void] {
  // Dark on the server: the default, and what the script falls back to.
  const theme = useSyncExternalStore(subscribe, current, () => 'dark' as const)

  const setTheme = useCallback((next: Theme) => {
    const apply = () => {
      document.documentElement.dataset.theme = next
      try {
        localStorage.setItem('theme', next)
      } catch {
        // Not remembered for next time; it still changes now.
      }
    }
    // A crossfade between the two where the browser can draw one.
    // A hidden page cannot draw one, and the browser abandons it; the theme
    // has changed by then either way, so that is not worth an error.
    if (typeof document.startViewTransition === 'function' && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const transition = document.startViewTransition(apply)
      transition.ready.catch(() => {})
      transition.finished.catch(() => {})
    } else {
      apply()
    }
  }, [])

  return [theme, setTheme]
}
