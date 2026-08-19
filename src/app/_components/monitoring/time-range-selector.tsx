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
    <div
      className="relative flex items-center gap-1 bg-secondary rounded-lg p-1"
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
            onClick={() => onChange(range)}
            className={cn(
              'relative px-3 py-1.5 text-sm font-medium rounded-md cursor-pointer',
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
            <span className="relative z-10 whitespace-nowrap">
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
