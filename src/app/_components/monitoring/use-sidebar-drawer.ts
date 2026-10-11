'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * From this width up the sidebar sits beside the page; below it, it is a
 * drawer over the page. Tailwind's `lg`, which is what the sidebar's own
 * classes switch on.
 */
const BESIDE_THE_PAGE = '(min-width: 64rem)'

/**
 * Whether the sidebar is open, on screens where it is a drawer.
 *
 * Open, it is the only thing that can be used: the page behind it is made
 * inert. So it must never be left open where it is not a drawer at all, or a
 * phone turned on its side, or a window dragged wider, would leave a page that
 * ignores every click with nothing on screen to explain why.
 */
export function useSidebarDrawer() {
  const [open, setOpen] = useState(false)

  const show = useCallback(() => setOpen(true), [])
  const hide = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return

    const handleKey = (event: KeyboardEvent) => {
      // A dialog opened from the drawer takes Escape first, and marks it taken.
      if (event.key === 'Escape' && !event.defaultPrevented) setOpen(false)
    }
    const beside = window.matchMedia(BESIDE_THE_PAGE)
    const handleWidth = () => {
      if (beside.matches) setOpen(false)
    }

    window.addEventListener('keydown', handleKey)
    beside.addEventListener('change', handleWidth)
    return () => {
      window.removeEventListener('keydown', handleKey)
      beside.removeEventListener('change', handleWidth)
    }
  }, [open])

  return { open, show, hide }
}
