'use client'

import { cn } from '@/lib/utils'
import { motion } from 'framer-motion'
import type { TimeRange } from '@/types/probe'
import { TIME_RANGE_CONFIG } from '@/types/probe'

interface TimeRangeSelectorProps {
  value: TimeRange
  onChange: (value: TimeRange) => void
}

export function TimeRangeSelector({ value, onChange }: TimeRangeSelectorProps) {
  const ranges: TimeRange[] = ['1h', '3h', '6h', '24h', '7d']

  return (
    <div className="flex items-center gap-1 bg-secondary rounded-lg p-1 " role="tablist" aria-label="Time range">
      {ranges.map(range => (
        <motion.button
          key={range}
          type="button"
          role="tab"
          aria-selected={value === range}
          onClick={() => onChange(range)}
          className={cn(
            'px-3 py-1.5 text-sm font-medium rounded-md transition-all cursor-pointer',
            value === range
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          )}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          transition={{ duration: 0.2 }}
        >
          <span className="relative z-10">{TIME_RANGE_CONFIG[range].label}</span>
        </motion.button>
      ))}
    </div>
  )
}
