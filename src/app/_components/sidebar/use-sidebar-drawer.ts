'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

/**
 * From this width up the sidebar sits beside the page; below it, it is a
 * drawer over the page. Tailwind's `lg`, which is what the sidebar's own
 * classes switch on.
 */
const BESIDE_THE_PAGE = '(min-width: 64rem)'

/** Where it is remembered that the sidebar was collapsed on a wide screen. */
const COLLAPSED_KEY = 'sidebarCollapsed'
const COLLAPSED_CHANGE = 'sidebarcollapsedchange'

/** The buttons that take the keyboard's focus when the one just pressed goes away. */
export const SIDEBAR_EXPAND_BUTTON_ID = 'sidebar-expand'
export const SIDEBAR_COLLAPSE_BUTTON_ID = 'sidebar-collapse'

/**
 * Whether the sidebar is collapsed, read from storage once and held here from
 * then on. Not read afresh each time: another tab changing it would otherwise
 * change this one in the middle of whatever it was doing.
 */
let collapsedNow: boolean | undefined

function isCollapsed() {
  if (collapsedNow === undefined) {
    try {
      collapsedNow = localStorage.getItem(COLLAPSED_KEY) !== null
    } catch {
      collapsedNow = false
    }
  }
  return collapsedNow
}

function setCollapsed(collapsed: boolean) {
  collapsedNow = collapsed
  try {
    if (collapsed) localStorage.setItem(COLLAPSED_KEY, '1')
    else localStorage.removeItem(COLLAPSED_KEY)
  } catch {
    // Not remembered for next time; it still changes now.
  }

  // The mark the script in the document head left for the first paint (see
  // `sidebar-collapsed` in globals.css). It holds the sidebar at its collapsed
  // width whatever else is asked of it, so it has to go before the width can
  // be animated, and from here on the components know the state themselves.
  delete document.documentElement.dataset.sidebar

  window.dispatchEvent(new Event(COLLAPSED_CHANGE))

  // The button that was pressed is on the side that has just been put away.
  // Focus goes to its opposite number, once that has been drawn.
  requestAnimationFrame(() => {
    document.getElementById(collapsed ? SIDEBAR_EXPAND_BUTTON_ID : SIDEBAR_COLLAPSE_BUTTON_ID)?.focus()
  })
}

function subscribeToCollapsed(onChange: () => void) {
  window.addEventListener(COLLAPSED_CHANGE, onChange)
  return () => window.removeEventListener(COLLAPSED_CHANGE, onChange)
}

function subscribeToWidth(onChange: () => void) {
  const beside = window.matchMedia(BESIDE_THE_PAGE)
  beside.addEventListener('change', onChange)
  return () => beside.removeEventListener('change', onChange)
}

const isBesideThePage = () => window.matchMedia(BESIDE_THE_PAGE).matches
const collapse = () => setCollapsed(true)
const expand = () => setCollapsed(false)

/**
 * Showing and hiding the sidebar, which means two different things.
 *
 * On a narrow screen it is a drawer, and `open` is whether it is out. Open, it
 * is the only thing that can be used: the page behind it is made inert. So it
 * must never be left open where it is not a drawer at all, or a phone turned
 * on its side, or a window dragged wider, would leave a page that ignores
 * every click with nothing on screen to explain why.
 *
 * On a wide screen it sits beside the page, and `collapsed` is whether it has
 * been folded down to a rail of icons. That is remembered between visits, and
 * means nothing on a narrow screen, where it is always reported as false.
 */
export function useSidebarDrawer() {
  const [open, setOpen] = useState(false)

  // Neither is known on the server. Both start as false there and in the
  // first render in the browser, and are corrected straight after it.
  const storedCollapsed = useSyncExternalStore(subscribeToCollapsed, isCollapsed, () => false)
  const beside = useSyncExternalStore(subscribeToWidth, isBesideThePage, () => false)

  const show = useCallback(() => setOpen(true), [])
  const hide = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return

    const handleKey = (event: KeyboardEvent) => {
      // A dialog opened from the drawer takes Escape first, and marks it taken.
      if (event.key === 'Escape' && !event.defaultPrevented) setOpen(false)
    }
    // A drawer left out when the window is widened is no longer a drawer.
    const width = window.matchMedia(BESIDE_THE_PAGE)
    const handleWidth = () => {
      if (width.matches) setOpen(false)
    }

    window.addEventListener('keydown', handleKey)
    width.addEventListener('change', handleWidth)
    return () => {
      window.removeEventListener('keydown', handleKey)
      width.removeEventListener('change', handleWidth)
    }
  }, [open])

  return {
    open,
    show,
    hide,
    collapsed: storedCollapsed && beside,
    collapse,
    expand,
  }
}
