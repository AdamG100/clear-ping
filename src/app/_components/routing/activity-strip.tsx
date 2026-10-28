'use client'

import { Tooltip } from '@/components/arc/tooltip/tooltip'
import type { BgpActivity } from '@/types/bgp'
import { displayTimeZone, wallClock } from '@/lib/time-zone'

/**
 * The updates RIS Live delivered for the prefix over the day, a bar every
 * fifteen minutes: a quiet prefix is a flat line, and a route moving shows as
 * a burst, withdrawals in red over announcements. A bar can be chosen, to
 * list just the updates in it.
 */

export function clock(time: number): string {
  const { hour, minute } = wallClock(time, displayTimeZone())
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function ActivityStrip({
  activity,
  sliceMs,
  selected,
  onSelect,
}: {
  activity: BgpActivity[]
  sliceMs: number
  /** The start of the bar chosen, if one is. */
  selected: number | null
  onSelect: (start: number | null) => void
}) {
  const most = Math.max(1, ...activity.map(slice => slice.announcements + slice.withdrawals))
  const total = activity.reduce((sum, slice) => sum + slice.announcements + slice.withdrawals, 0)
  // Log-scaled, so one update still shows beside a burst of hundreds.
  const scale = (count: number) => (count === 0 ? 0 : Math.max(8, (Math.log1p(count) / Math.log1p(most)) * 100))
  const zone = displayTimeZone()

  return (
    <div>
      <div className="flex h-16 items-end gap-px" role="group" aria-label={`${total} BGP updates in the last 24 hours`}>
        {activity.map(slice => {
          const count = slice.announcements + slice.withdrawals
          const height = scale(count)
          return (
            <Tooltip
              key={slice.start}
              content={
                count === 0
                  ? `${clock(slice.start)}: no updates`
                  : `${clock(slice.start)} to ${clock(slice.start + sliceMs)}: ${slice.announcements} announced, ${slice.withdrawals} withdrawn`
              }
            >
              {count === 0 ? (
                <span className="flex h-full min-w-0 flex-1 flex-col justify-end" aria-hidden="true">
                  <span className="block h-0.5 rounded-full bg-muted" />
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(selected === slice.start ? null : slice.start)}
                  aria-pressed={selected === slice.start}
                  aria-label={`${clock(slice.start)}: ${slice.announcements} announced, ${slice.withdrawals} withdrawn`}
                  className={`flex h-full min-w-0 flex-1 cursor-pointer flex-col justify-end rounded-sm transition-opacity ${selected !== null && selected !== slice.start ? 'opacity-35' : ''} ${selected === slice.start ? 'bg-primary/15' : 'hover:bg-muted/60'}`}
                >
                  <span className="flex flex-col overflow-hidden rounded-sm" style={{ height: `${height}%` }}>
                    <span className="block bg-signal-critical" style={{ flex: slice.withdrawals }} />
                    <span className="block bg-primary" style={{ flex: slice.announcements }} />
                  </span>
                </button>
              )}
            </Tooltip>
          )
        })}
      </div>
      <div className="relative mt-1.5 h-4 font-mono text-[10px] text-muted-foreground">
        {activity.map((slice, index) => {
          const { hour, minute } = wallClock(slice.start, zone)
          if (minute !== 0 || hour % 6 !== 0) return null
          return (
            <span key={slice.start} className="absolute -translate-x-1/2" style={{ left: `${(index / activity.length) * 100}%` }}>
              {String(hour).padStart(2, '0')}:00
            </span>
          )
        })}
      </div>
      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-primary" aria-hidden="true" />Announced</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-signal-critical" aria-hidden="true" />Withdrawn</span>
        <span>{total} update{total === 1 ? '' : 's'} in 24 hours</span>
      </p>
    </div>
  )
}
