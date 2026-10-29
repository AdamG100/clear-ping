'use client'

import { useLayoutEffect, useRef, type ReactNode } from 'react'

/**
 * Whatever a search box filters, eased from one set of results to the next.
 *
 * Without it every key pressed swapped the list at once: rows vanished, the
 * list jumped to its new height and everything under it jumped with it. Here
 * the height glides to the new one and the results fade up into place, so the
 * eye can follow what changed. Typing on before it has finished picks up from
 * wherever it had got to rather than starting again from the old height.
 *
 * `query` is what the results are filtered by: only a change in it animates,
 * not the list changing for any other reason (new readings arriving).
 */

const DURATION_MS = 220
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

export function SearchResults({ query, className, children }: { query: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  /** The height it settled at, while no change is being eased. */
  const settled = useRef<number | null>(null)
  const easing = useRef<Animation[]>([])
  const first = useRef(true)

  // Kept up to date as the results change by themselves, so a search starts
  // from the height that is really on screen.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (easing.current.length === 0) settled.current = element.getBoundingClientRect().height
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    if (first.current) {
      first.current = false
      settled.current = element.getBoundingClientRect().height
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    // Mid-change, what is on screen is the height it had got to.
    const from = easing.current.length > 0 ? element.getBoundingClientRect().height : settled.current
    for (const animation of easing.current) animation.cancel()
    const to = element.getBoundingClientRect().height

    const timing = { duration: DURATION_MS, easing: EASING }
    const running: Animation[] = [
      element.animate([{ opacity: 0.35, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], timing),
    ]
    if (from !== null && Math.abs(from - to) > 1) {
      element.style.overflow = 'hidden'
      running.push(element.animate([{ height: `${from}px` }, { height: `${to}px` }], timing))
    }
    easing.current = running

    Promise.all(running.map(animation => animation.finished))
      .then(() => {
        if (easing.current !== running) return
        easing.current = []
        element.style.overflow = ''
        settled.current = element.getBoundingClientRect().height
      })
      .catch(() => {
        // Cancelled by the next key pressed, which takes it from here.
      })
  }, [query])

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
