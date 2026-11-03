'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

const EASE = [0.2, 0, 0, 1] as const

/**
 * One view of a monitor swapped for another (Compare, a probe, IPv4, IPv6),
 * without the page jumping.
 *
 * The two views cross-fade in the same place: the old one is taken out of the
 * flow as it fades, so the new one never waits below an empty space. The room
 * they take is what moves, from the old view's height to the new one's, so
 * everything under them (the route, the alerts) glides rather than collapsing
 * and springing back. The same goes for a view that grows once its readings
 * arrive. Overflow is clipped only while the height moves, so tooltips and
 * menus in the view are never cut off once it has settled.
 */
export function ViewSwap({
  viewKey,
  holdKey,
  className,
  children,
}: {
  /** A different view: the old one fades out and this one in. */
  viewKey: string
  /** The same view with other readings coming, such as another probe's: no fade, but its height is held while they load. */
  holdKey?: string
  className?: string
  children: ReactNode
}) {
  const reduce = useReducedMotion()
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState<number | null>(null)
  // While a new view loads its readings it is briefly shorter than it will be:
  // the old view's height is held as a floor until it has filled in, so the
  // page does not dip and come back.
  const [floor, setFloor] = useState<number | null>(null)
  const [moving, setMoving] = useState(false)
  const shownKey = useRef(`${viewKey}|${holdKey ?? ''}`)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const giveUp = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useLayoutEffect(() => {
    const node = inner.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      setMeasured(entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight)
      // Filled in once it has stopped growing for a moment.
      clearTimeout(settle.current)
      settle.current = setTimeout(() => setFloor(null), 250)
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
      clearTimeout(settle.current)
      clearTimeout(giveUp.current)
    }
  }, [])

  // A new view: hold the height it leaves, for as long as the new one takes to load, up to a limit.
  useLayoutEffect(() => {
    const key = `${viewKey}|${holdKey ?? ''}`
    if (shownKey.current === key) return
    shownKey.current = key
    // The outer box has not moved yet; the inner one already holds the new view.
    const leaving = outer.current?.offsetHeight
    if (!leaving) return
    setFloor(leaving)
    clearTimeout(giveUp.current)
    giveUp.current = setTimeout(() => setFloor(null), 800)
  }, [viewKey, holdKey])

  const height = measured === null ? 'auto' : Math.max(measured, floor ?? 0)

  return (
    <motion.div
      ref={outer}
      initial={false}
      animate={{ height }}
      transition={reduce ? { duration: 0 } : { duration: 0.3, ease: EASE }}
      onAnimationStart={() => setMoving(true)}
      onAnimationComplete={() => setMoving(false)}
      // Not an anchor for the browser's scroll anchoring: the leaving view is
      // lifted out of the flow as it fades, and Chrome would otherwise move the
      // page to keep it in place.
      style={{ overflow: moving ? 'hidden' : 'visible', overflowAnchor: 'none' }}
    >
      {/* The positioned box the leaving view is held in while it fades. */}
      <div ref={inner} className="relative">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={viewKey}
            className={className}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: reduce ? { duration: 0 } : { duration: 0.24, ease: EASE, delay: 0.04 } }}
            exit={{ opacity: 0, transition: reduce ? { duration: 0 } : { duration: 0.14, ease: 'easeIn' } }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
