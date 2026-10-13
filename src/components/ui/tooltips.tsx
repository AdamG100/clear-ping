'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

/**
 * The names of things, shown beside them as the pointer rests there.
 *
 * Much of the app is icons, and an icon says nothing until it has been
 * learned. The browser's own `title` does answer, but a second late and in its
 * own small print; this comes up at once, in the app's colours.
 *
 * It is one listener for the whole page and not a wrapper around each button,
 * so nothing has to be laid out differently to be given a name:
 *
 *  - `data-tip="…"` on anything names it, with `data-tip-detail` for a second,
 *    quieter line and `data-tip-side` for where to stand (above by default).
 *  - A button with no words in it, only an icon, is named by its `aria-label`
 *    without being asked. That is what the label is already there to say.
 *  - `data-tip=""` says that nothing here needs saying.
 *
 * What is shown repeats what the element already tells a screen reader, so it
 * is hidden from one and not announced twice.
 */

type Side = 'top' | 'bottom' | 'right'

interface Tip {
  id: number
  label: string
  detail: string | null
  side: Side
  /** Where what it names was on the screen as it opened. */
  box: DOMRect
}

/** How long the pointer rests on something before its name comes up. */
const SHOW_AFTER_MS = 250
/** Moving on to the next thing within this long of one closing skips the wait. */
const WARM_FOR_MS = 500
/** The space between a thing and its name. */
const GAP = 8
/** The nearest a name comes to the edge of the window. */
const EDGE = 6

const CAN_BE_NAMED = '[data-tip], button, a[href], [role="button"]'

/** Whether there is anything to read in it besides what only a screen reader is given. */
function hasWords(element: Element): boolean {
  const texts = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let text = texts.nextNode(); text; text = texts.nextNode()) {
    if (!text.textContent?.trim()) continue
    const unseen = text.parentElement?.closest('.sr-only, [aria-hidden="true"]')
    if (!unseen || !element.contains(unseen)) return true
  }
  return false
}

/** The nearest thing around `start` that has a name to show. */
function named(start: EventTarget | null): Element | null {
  if (!(start instanceof Element)) return null
  for (let element = start.closest(CAN_BE_NAMED); element; element = element.parentElement?.closest(CAN_BE_NAMED) ?? null) {
    const given = element.getAttribute('data-tip')
    if (given !== null) return given.trim() ? element : null
    if (element.getAttribute('aria-label')?.trim() && !hasWords(element)) return element
  }
  return null
}

function sideOf(element: Element): Side {
  const asked = element.getAttribute('data-tip-side')
  return asked === 'right' || asked === 'bottom' ? asked : 'top'
}

/** Puts the name beside what it names: on the side asked for if it fits there, and never off the window. */
function place(node: HTMLElement, { box, side }: Tip) {
  // Its size as laid out, which the scale it opens at does not change.
  const width = node.offsetWidth
  const height = node.offsetHeight
  const windowWidth = document.documentElement.clientWidth
  const windowHeight = window.innerHeight

  let on = side
  if (on === 'right' && box.right + GAP + width > windowWidth - EDGE) on = 'top'
  if (on === 'top' && box.top - GAP - height < EDGE) on = 'bottom'
  else if (on === 'bottom' && box.bottom + GAP + height > windowHeight - EDGE) on = 'top'

  const left = on === 'right' ? box.right + GAP : box.left + box.width / 2 - width / 2
  const top =
    on === 'right' ? box.top + box.height / 2 - height / 2 : on === 'top' ? box.top - GAP - height : box.bottom + GAP

  node.style.left = `${Math.round(Math.max(EDGE, Math.min(left, windowWidth - EDGE - width)))}px`
  node.style.top = `${Math.round(Math.max(EDGE, Math.min(top, windowHeight - EDGE - height)))}px`
}

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null)
  // Nothing is put in the body until there has been something to show.
  const [used, setUsed] = useState(false)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    /** What the pointer is resting on, or the keyboard has reached. */
    let on: Element | null = null
    let shown = false
    let waiting: ReturnType<typeof setTimeout> | null = null
    let closedAt = -Infinity
    let count = 0

    const stopWaiting = () => {
      if (waiting) clearTimeout(waiting)
      waiting = null
    }

    const open = (element: Element) => {
      stopWaiting()
      const label = (element.getAttribute('data-tip') ?? element.getAttribute('aria-label') ?? '').trim()
      // It may have gone, or lost its name, in the moment the pointer rested on it.
      if (!label || !element.isConnected) return
      shown = true
      setUsed(true)
      setTip({
        id: ++count,
        label,
        detail: element.getAttribute('data-tip-detail')?.trim() || null,
        side: sideOf(element),
        box: element.getBoundingClientRect(),
      })
    }

    /** Puts the name away. What it was for is remembered, so it does not come straight back. */
    const close = () => {
      stopWaiting()
      if (shown) closedAt = performance.now()
      shown = false
      setTip(null)
    }

    const leave = () => {
      close()
      on = null
    }

    const onPointerOver = (event: PointerEvent) => {
      // A finger has no hover: a tap would only flash the name as the button
      // does its work.
      if (event.pointerType !== 'mouse') return
      const next = named(event.target)
      if (next === on) return
      close()
      on = next
      if (!next) return
      // Running along a row of buttons does not wait at every one.
      if (performance.now() - closedAt < WARM_FOR_MS) open(next)
      else waiting = setTimeout(() => open(next), SHOW_AFTER_MS)
    }

    // Tabbing onto something shows its name too. Read from the key and not
    // from focus, which also returns to a button when a dialog it opened is
    // closed, and the name would then sit beside it for no reason.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const next = named(document.activeElement)
      close()
      on = next
      if (next) open(next)
    }

    const onFocusOut = (event: FocusEvent) => {
      if (on && event.target instanceof Node && on.contains(event.target)) leave()
    }

    // Pressed, it has been found; and a key, Escape or any other, means the
    // attention has gone elsewhere. Where the name stands was measured as it
    // opened: if the page scrolls under it, it is left pointing at the wrong
    // thing.
    document.addEventListener('pointerover', onPointerOver)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('keydown', close)
    document.addEventListener('focusout', onFocusOut)
    document.documentElement.addEventListener('mouseleave', leave)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', leave)

    return () => {
      stopWaiting()
      document.removeEventListener('pointerover', onPointerOver)
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('keydown', close)
      document.removeEventListener('focusout', onFocusOut)
      document.documentElement.removeEventListener('mouseleave', leave)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', leave)
    }
  }, [])

  if (!used) return null

  // In the body, above everything: a dialog, and whatever would clip a name
  // that reaches past its edge.
  return createPortal(
    <AnimatePresence>
      {tip && (
        <motion.div
          key={tip.id}
          ref={node => {
            if (node) place(node, tip)
          }}
          data-tooltip=""
          aria-hidden="true"
          className="pointer-events-none fixed left-0 top-0 z-70 w-max max-w-64 rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-xs font-medium leading-snug text-popover-foreground shadow-lg backdrop-blur-sm"
          initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.08 } }}
          transition={{ duration: reduceMotion ? 0 : 0.12, ease: 'easeOut' }}
        >
          <span className="block wrap-break-word">{tip.label}</span>
          {tip.detail && <span className="mt-0.5 block wrap-break-word font-normal text-muted-foreground">{tip.detail}</span>}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
