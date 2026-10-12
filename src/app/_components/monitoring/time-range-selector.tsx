'use client'

import { cn } from '@/lib/utils'
import { motion } from 'framer-motion'
import type { TimeRange } from '@/types/probe'
import { TIME_RANGE_CONFIG } from '@/types/probe'

interface TimeRangeSelectorProps {
  value: TimeRange
  onChange: (value: TimeRange) => void
  /** A range change is still loading; shown on the control that triggered it. */
  busy?: boolean
}

const RANGES = Object.keys(TIME_RANGE_CONFIG) as TimeRange[]

/**
 * The ranges in the two groups they are thought of in: those within a day,
 * which are for watching something happen, and those of days, which are for
 * looking back at it.
 */
const GROUPS = [
  RANGES.filter(range => TIME_RANGE_CONFIG[range].hours <= 24),
  RANGES.filter(range => TIME_RANGE_CONFIG[range].hours > 24),
]

/**
 * Which period the charts show.
 *
 * Every range is one press away and all of them are on screen at once: with
 * nine there is still room for that, and a menu would hide the choice behind
 * a press of its own. What makes nine fit is that each is written the short
 * way (`6h`, `30d`), with its full name for a screen reader and on hover.
 *
 * Sized from the main pane it sits in (see pane-layout.ts). On one line the
 * two groups are told apart by a rule between them. Where the pane is too
 * narrow for nine tabs wide enough to press, a phone held upright, each group
 * takes a line of its own.
 */
export function TimeRangeSelector({ value, onChange, busy = false }: TimeRangeSelectorProps) {
  return (
    <div
      className="relative flex w-full flex-wrap items-center gap-1 rounded-lg bg-secondary p-1 @lg/main:flex-nowrap @3xl/main:w-auto"
      role="tablist"
      aria-label="Time range"
    >
      {GROUPS.map((group, i) => (
        <div key={i} role="presentation" className="flex flex-1 basis-full items-center gap-1 @lg/main:basis-auto">
          {i > 0 && (
            <span aria-hidden="true" className="mx-0.5 hidden h-4 w-px shrink-0 bg-border @lg/main:block" />
          )}
          {group.map(range => {
            const selected = value === range
            return (
              <button
                key={range}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={TIME_RANGE_CONFIG[range].label}
                title={TIME_RANGE_CONFIG[range].label}
                onClick={() => onChange(range)}
                className={cn(
                  'relative flex-1 cursor-pointer rounded-md px-2 py-1.5 font-mono text-xs font-medium touch:py-2.5',
                  '@3xl/main:flex-none @3xl/main:px-2.5',
                  'transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {/* One shared element slides between tabs via layoutId, instead of
                    the background colour snapping from one button to another. */}
                {selected && (
                  <motion.span
                    layoutId="time-range-indicator"
                    className="absolute inset-0 rounded-md bg-primary shadow-sm"
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="relative z-10 whitespace-nowrap">{range}</span>
              </button>
            )
          })}
        </div>
      ))}

      {/* Progress hairline along the bottom of the control, so the feedback for
          "this range is loading" sits on the thing that was clicked rather than
          over the chart. */}
      {busy && (
        <motion.span
          className="absolute inset-x-1 bottom-0 h-0.5 origin-left rounded-full bg-primary/60"
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      )}
    </div>
  )
}
