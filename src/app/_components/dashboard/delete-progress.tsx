'use client'

import { cn } from '@/lib/utils'

/**
 * How far a delete has got. Shown over the corner of the page for as long as
 * the delete runs in the background, where the notification that it has
 * finished then takes its place.
 *
 * One target, or groups with nothing in them, is a single request with no
 * steps to count, so the bar only says it is under way.
 */
export function DeleteProgress({ title, done, total }: { title: string; done: number; total: number }) {
  const counted = total > 1
  return (
    <div
      role="status"
      className="fixed bottom-6 right-6 z-50 w-[min(22.5rem,calc(100%-2rem))] space-y-2 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg"
    >
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
        {counted && (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {done} of {total}
          </span>
        )}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={counted ? total : undefined}
        aria-valuenow={counted ? done : undefined}
      >
        <div
          className={cn(
            'h-full rounded-full bg-primary',
            counted
              ? 'transition-[width] duration-200 motion-reduce:transition-none'
              : 'w-full animate-pulse opacity-60 motion-reduce:animate-none'
          )}
          style={counted ? { width: `${total > 0 ? (done / total) * 100 : 0}%` } : undefined}
        />
      </div>
      <p className="text-xs text-muted-foreground">You can carry on working while this finishes.</p>
    </div>
  )
}
