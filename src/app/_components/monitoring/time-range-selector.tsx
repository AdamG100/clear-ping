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

const RANGES: TimeRange[] = ['1h', '3h', '6h', '24h', '7d']

export function TimeRangeSelector({ value, onChange, busy = false }: TimeRangeSelectorProps) {
  return (
    // Sized from the main pane it sits in (see pane-layout.ts). Where the pane
    // is narrow the control takes the full width and its tabs share it; with
    // more room it is as wide as its tabs.
    <div
      className="relative flex w-full items-center gap-1 rounded-lg bg-secondary p-1 @xl/main:w-auto"
      role="tablist"
      aria-label="Time range"
    >
      {RANGES.map(range => {
        const selected = value === range
        return (
          <button
            key={range}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={TIME_RANGE_CONFIG[range].label}
            onClick={() => onChange(range)}
            className={cn(
              'relative flex-1 cursor-pointer rounded-md px-2 py-1.5 text-sm font-medium @xl/main:flex-none @xl/main:px-3',
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
            {/* "24 Hours" five times over is wider than a phone, and wide
                enough to crowd the page's title off its line on a small
                laptop. Until the pane has room for it, the short form. */}
            <span className="relative z-10 whitespace-nowrap @5xl/main:hidden">{range}</span>
            <span className="relative z-10 hidden whitespace-nowrap @5xl/main:inline">
              {TIME_RANGE_CONFIG[range].label}
            </span>
          </button>
        )
      })}

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
