'use client'

/**
 * Placeholders shaped like the content they stand in for.
 *
 * Switching targets used to replace the whole pane with a centred spinner,
 * which collapsed the layout and then rebuilt it a moment later — the page
 * visibly jumped twice per click. Holding the same shape means only the values
 * change, so the eye stays where it was.
 */

function Block({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted/50 ${className}`} />
}

export function ReadoutSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-3" aria-hidden="true">
      {[0, 1, 2].map(i => (
        <div key={i} className="rounded-xl border border-border/50 bg-card p-6">
          <div className="flex items-center gap-3">
            <Block className="h-10 w-10 rounded-lg" />
            <Block className="h-4 w-24" />
          </div>
          <Block className="mt-6 h-9 w-32" />
          <Block className="mt-2 h-3 w-40" />
          <div className="mt-6 grid grid-cols-4 gap-4 border-t border-border/50 pt-4">
            {[0, 1, 2, 3].map(j => (
              <div key={j} className="space-y-1.5">
                <Block className="h-2 w-8" />
                <Block className="h-4 w-12" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function TraceSkeleton() {
  return (
    <div className="flex h-[20rem] flex-col justify-end gap-3" aria-hidden="true">
      {/* Suggests a trace rather than a generic box, so the placeholder reads
          as "a graph is coming" instead of "something is broken". */}
      <svg viewBox="0 0 400 120" className="h-full w-full" preserveAspectRatio="none">
        <path
          d="M0 78 L40 72 L80 84 L120 60 L160 70 L200 66 L240 74 L280 52 L320 68 L360 62 L400 70"
          fill="none"
          stroke="currentColor"
          className="animate-pulse text-muted-foreground/25"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  )
}
