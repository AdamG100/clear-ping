'use client'

/**
 * How far a bulk delete has got. Shown over the corner of the page for as long
 * as the delete runs in the background, where the notification that it has
 * finished then takes its place.
 */
export function DeleteProgress({ done, total }: { done: number; total: number }) {
  return (
    <div
      role="status"
      className="fixed bottom-6 right-6 z-50 w-[min(22.5rem,calc(100%-2rem))] space-y-2 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg"
    >
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-foreground">Deleting targets</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {done} of {total}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Deleting targets"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
          style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">You can carry on working while this finishes.</p>
    </div>
  )
}
