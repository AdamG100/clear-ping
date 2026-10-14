'use client'

import { motion } from 'motion/react'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
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
 * Which period the charts show.
 *
 * Every range is one press away and all of them are on screen at once: with
 * nine there is still room for that, and a menu would hide the choice behind
 * a press of its own. What makes nine fit is that each is written the short
 * way (`6h`, `30d`). Where the pane is too narrow for all nine, the control
 * scrolls sideways and keeps the chosen one in view.
 */
export function TimeRangeSelector({ value, onChange, busy = false }: TimeRangeSelectorProps) {
  return (
    <div className="relative flex min-w-0 max-w-full">
      <SegmentedControl
        label="Time range"
        value={value}
        onValueChange={range => onChange(range as TimeRange)}
        options={RANGES.map(range => ({ value: range, label: range }))}
      />

      {/* Progress hairline along the bottom of the control, so the feedback for
          "this range is loading" sits on the thing that was clicked rather than
          over the chart. */}
      {busy && (
        <motion.span
          className="absolute inset-x-3 bottom-0 h-0.5 origin-left rounded-full bg-primary/60"
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      )}
    </div>
  )
}
