'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

/**
 * The name of a button on the collapsed sidebar, shown beside it.
 *
 * The rail is icons and initials, which say nothing until they have been
 * learned. The browser's own `title` does answer, but a second late and in its
 * own small print; this comes up at once, to the right of the button, in the
 * app's colours.
 *
 * It repeats what the button's `aria-label` already says, so it is hidden from
 * a screen reader and not announced twice.
 */

/** How long the pointer rests on a button before its name comes up. */
const SHOW_AFTER_MS = 200
/** Moving on to the next button within this long of one closing skips the wait. */
const WARM_FOR_MS = 500
/** The space between the button and its name. */
const GAP = 10

/** When a name on the rail last closed, by the page's clock. Shared, so that running down the rail does not wait at every button. */
let lastClosedAt = -Infinity

export function RailTip({
  label,
  detail,
  children,
}: {
  label: string
  /** A second, quieter line: how the group is doing. */
  detail?: ReactNode
  children: ReactNode
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isOpen = useRef(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  // Nothing is put in the body for a button nobody has pointed at.
  const [used, setUsed] = useState(false)
  const reduceMotion = useReducedMotion()

  const stopWaiting = useCallback(() => {
    if (waiting.current) clearTimeout(waiting.current)
    waiting.current = null
  }, [])

  const show = useCallback(() => {
    stopWaiting()
    const box = anchor.current?.getBoundingClientRect()
    if (!box) return
    isOpen.current = true
    setUsed(true)
    setAt({ left: box.right + GAP, top: box.top + box.height / 2 })
  }, [stopWaiting])

  const hide = useCallback(() => {
    stopWaiting()
    if (isOpen.current) lastClosedAt = performance.now()
    isOpen.current = false
    setAt(null)
  }, [stopWaiting])

  const showSoon = useCallback(() => {
    stopWaiting()
    if (performance.now() - lastClosedAt < WARM_FOR_MS) show()
    else waiting.current = setTimeout(show, SHOW_AFTER_MS)
  }, [show, stopWaiting])

  useEffect(() => stopWaiting, [stopWaiting])

  // Where it stands was measured as it opened. If the rail scrolls under it,
  // it would be left pointing at the wrong button.
  useEffect(() => {
    if (!at) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [at, hide])

  return (
    <span
      ref={anchor}
      className="flex shrink-0"
      // A finger has no hover: a tap would only flash the name as the button
      // does its work.
      onPointerEnter={event => event.pointerType === 'mouse' && showSoon()}
      onPointerLeave={hide}
      // Pressed, it has been found.
      onPointerDown={hide}
      // Tabbing onto a button shows its name too. Read from the key and not
      // from focus, which also returns here when a dialog the button opened is
      // closed, and the name would then sit beside it for no reason.
      onKeyUp={event => event.key === 'Tab' && show()}
      onBlur={hide}
    >
      {children}
      {used &&
        createPortal(
          <AnimatePresence>
            {at && (
              <motion.div
                aria-hidden="true"
                // Out of the sidebar altogether: the rail clips whatever
                // reaches past its edge.
                className="pointer-events-none fixed z-50 max-w-72 -translate-y-1/2 rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-lg backdrop-blur-sm"
                style={{ left: at.left, top: at.top }}
                initial={{ opacity: 0, x: reduceMotion ? 0 : -4 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.08 } }}
                transition={{ duration: reduceMotion ? 0 : 0.12, ease: 'easeOut' }}
              >
                <span className="block truncate">{label}</span>
                {detail && <span className="mt-0.5 block truncate font-normal text-muted-foreground">{detail}</span>}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </span>
  )
}
