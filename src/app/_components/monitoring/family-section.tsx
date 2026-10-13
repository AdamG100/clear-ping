'use client'

import { Children, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import { cn } from '@/lib/utils'
import { FAMILY_LABEL } from '@/lib/host'
import { resolversThatDiffer } from '@/lib/dns-resolver-series'
import type { AddressFamily, FamilyReading } from '@/types/probe'

/**
 * One address family's part of a page that compares the two.
 *
 * A DNS target on both families has a table and a chart for each of them, and
 * laid end to end under the comparison they were four boxes with nothing to
 * say which went with which. Here each family is one box with its name on it,
 * folded away until it is wanted: the heading says how that family's latest
 * probe went, which is often all that was being looked for.
 */

/** Where it is remembered which families were left open. */
const OPEN_FAMILIES_KEY = 'openFamilySections'

function readOpenFamilies(): AddressFamily[] {
  if (typeof window === 'undefined') return []
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(OPEN_FAMILIES_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((family): family is AddressFamily => family === 4 || family === 6) : []
  } catch {
    return []
  }
}

function saveOpen(family: AddressFamily, open: boolean) {
  try {
    const others = readOpenFamilies().filter(each => each !== family)
    localStorage.setItem(OPEN_FAMILIES_KEY, JSON.stringify(open ? [...others, family] : others))
  } catch {
    // Not remembered for next time; it still changes now.
  }
}

/** How a family's latest probe went, in the few words there is room for beside its name. */
function summaryOf(latest: FamilyReading | undefined) {
  if (!latest) return null

  const readings = latest.details?.resolvers ?? []
  // Out of how many, where every reading kept that; as a share where one did not.
  const counted = readings.length > 0 && readings.every(reading => reading.sent)
  const sent = readings.reduce((sum, reading) => sum + (reading.sent ?? 0), 0)
  const answered = readings.reduce((sum, reading) => sum + Math.round((reading.sent ?? 0) * (1 - reading.loss / 100)), 0)

  return {
    latency: latest.latency,
    answered: counted ? `${answered} of ${sent} queries answered` : `${(100 - latest.packetLoss).toFixed(0)}% of queries answered`,
    silent: readings.filter(reading => reading.latency === null).length,
    differing: resolversThatDiffer(readings).size > 0,
    tone: !latest.success ? 'bg-destructive' : latest.packetLoss > 0 ? 'bg-signal-moderate' : 'bg-signal-perfect',
  }
}

interface FamilySectionProps {
  family: AddressFamily
  /** What is looked up over this family: "A record". */
  detail?: string
  latest: FamilyReading | undefined
  children: ReactNode
}

// ─── Opening and folding ────────────────────────────────────────────────────

/** The curve the rest of the page moves on: quick away, long to settle. */
const EASE = [0.2, 0, 0, 1] as const

/**
 * The box grows to the height of what is in it, and what is in it comes up
 * into place a part at a time, the table before the chart, so the eye is led
 * down the section rather than handed all of it at once. Folding is the same
 * in reverse and quicker: something being put away is not being read.
 *
 * It grows as a grid row from none of its content's height to all of it, not
 * to a height measured when it began. The chart inside is still loading then
 * and is taller once it has: measured at the start, the box stopped two
 * hundred pixels short and jumped the rest of the way when it finished.
 *
 * Clipped only while it moves. Left clipped, a chart's tooltip that reaches
 * past the edge of the box would be cut off at it.
 */
const BODY: Variants = {
  open: {
    gridTemplateRows: '1fr',
    opacity: 1,
    overflow: 'hidden',
    transition: {
      gridTemplateRows: { duration: 0.38, ease: EASE },
      opacity: { duration: 0.2, ease: 'easeOut' },
      delayChildren: 0.06,
      staggerChildren: 0.08,
    },
    transitionEnd: { overflow: 'visible' },
  },
  closed: {
    gridTemplateRows: '0fr',
    opacity: 0,
    overflow: 'hidden',
    transition: {
      gridTemplateRows: { duration: 0.26, ease: EASE },
      opacity: { duration: 0.16, ease: 'easeIn' },
    },
  },
}

const PART: Variants = {
  open: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE } },
  closed: { opacity: 0, y: 12, transition: { duration: 0.12, ease: 'easeIn' } },
}

/** For anyone whose system asks for less motion: the same change, without the travel. */
const BODY_INSTANT: Variants = {
  open: { gridTemplateRows: '1fr', opacity: 1, transition: { duration: 0 } },
  closed: { gridTemplateRows: '0fr', opacity: 0, transition: { duration: 0 } },
}
const PART_INSTANT: Variants = { open: { opacity: 1 }, closed: { opacity: 1 } }

/** The arrow turns on a spring, the way the switch above the sections slides. */
const TURN = { type: 'spring', stiffness: 420, damping: 30 } as const

export function FamilySection({ family, detail, latest, children }: FamilySectionProps) {
  const [open, setOpen] = useState(() => readOpenFamilies().includes(family))
  const id = useId()
  const reduceMotion = useReducedMotion()
  const summary = summaryOf(latest)

  const toggle = () => {
    saveOpen(family, !open)
    setOpen(!open)
  }

  return (
    <section className="rounded-xl border border-border bg-card/40">
      <h2>
        <button
          type="button"
          id={`${id}-heading`}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={toggle}
          className={cn(
            'flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3 text-left outline-none transition-colors @2xl/main:px-5',
            'hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 touch:py-4',
            open && 'rounded-b-none'
          )}
        >
          <motion.span
            className="flex shrink-0 text-muted-foreground"
            initial={false}
            animate={{ rotate: open ? 90 : 0 }}
            transition={reduceMotion ? { duration: 0 } : TURN}
            aria-hidden="true"
          >
            <ChevronRight className="h-4 w-4" />
          </motion.span>
          {summary && <span className={cn('h-2 w-2 shrink-0 rounded-full', summary.tone)} aria-hidden="true" />}
          <span className="text-sm font-medium text-foreground">{FAMILY_LABEL[family]}</span>
          {detail && <span className="text-xs text-muted-foreground">{detail}</span>}

          <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {!summary ? (
              <span>No reading yet</span>
            ) : (
              <>
                {summary.silent > 0 && (
                  <span className="text-destructive">
                    {summary.silent} resolver{summary.silent === 1 ? '' : 's'} not answering
                  </span>
                )}
                {summary.differing && <span className="text-signal-moderate">answers differ</span>}
                <span>{summary.answered}</span>
                <span className="font-mono text-foreground">
                  {summary.latency === null ? 'no answer' : `${summary.latency.toFixed(1)} ms`}
                </span>
              </>
            )}
            <span className="sr-only">{open ? 'Hide' : 'Show'} the details</span>
          </span>
        </button>
      </h2>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            id={`${id}-body`}
            role="region"
            aria-labelledby={`${id}-heading`}
            className="grid"
            variants={reduceMotion ? BODY_INSTANT : BODY}
            initial="closed"
            animate="open"
            exit="closed"
          >
            {/* The one row, allowed to be shorter than what is in it. The
                padding and the rule are inside it, so that folded all the way
                there is nothing of them left. */}
            <div className="min-h-0 min-w-0">
              <div className="space-y-3 border-t border-border p-3 @2xl/main:space-y-4 @2xl/main:p-4">
                {Children.toArray(children).map((child, index) => (
                  <motion.div key={index} variants={reduceMotion ? PART_INSTANT : PART}>
                    {child}
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
