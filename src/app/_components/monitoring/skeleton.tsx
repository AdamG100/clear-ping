'use client'

import { cn } from '@/lib/utils'
import { PANE, PANE_HEADER } from './pane-layout'
import { STAT_GRID, STAT_GRID_LEAD } from './stats-cards'

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
    // The same grid and the same boxes as the cards these stand in for, down
    // to how the four figures fold at each width.
    <div className={STAT_GRID} aria-hidden="true">
      {[0, 1, 2].map(i => (
        <div
          key={i}
          className={cn(
            '@container/card rounded-xl border border-border/50 bg-card p-4 @2xl/main:p-6',
            i === 0 && STAT_GRID_LEAD
          )}
        >
          <div className="flex items-center gap-3">
            <Block className="h-10 w-10 rounded-lg" />
            <Block className="h-4 w-24" />
          </div>
          <Block className="mt-4 h-9 w-32 @2xl/main:mt-6" />
          <Block className="mt-2 h-3 w-40" />
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border/50 pt-4 @2xs/card:grid-cols-4 @2xl/main:mt-6">
            {/* As tall as a label over a figure, so the cards do not grow when
                the figures arrive and push the chart down the page. */}
            {[0, 1, 2, 3].map(j => (
              <div key={j} className="flex h-[40.5px] flex-col justify-between py-1">
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

/**
 * The whole main pane, for before the list of targets has arrived.
 *
 * Until then there is nothing to say what is on screen, and the pane used to
 * fill the gap with the "pick a path" message meant for an installation with
 * no targets at all. It showed on every refresh, for as long as the list took
 * to load, and was then replaced by the target that had been selected all
 * along. This holds the shape of that target's page instead.
 */
export function PaneSkeleton() {
  return (
    <div className={PANE} role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className={PANE_HEADER} aria-hidden="true">
        <div>
          <Block className="h-7 w-56 max-w-full @2xl/main:h-8" />
          <Block className="mt-1 h-5 w-72 max-w-full" />
        </div>
        <Block className="h-10 w-full rounded-lg @xl/main:w-72" />
      </div>

      {/* A group's page has no readouts. Which kind of page was left open is
          only known in the browser, so it is the stylesheet that leaves these
          out, from a mark set on the document before anything is drawn. */}
      <div className="skeleton-target-only">
        <ReadoutSkeleton />
      </div>

      <section className="min-h-[26rem] rounded-xl border border-border bg-card p-4 @2xl/main:p-5" aria-hidden="true">
        <div className="mb-4">
          <Block className="h-5 w-40" />
          <Block className="mt-0.5 h-4 w-80 max-w-full" />
        </div>
        <TraceSkeleton />
      </section>
    </div>
  )
}

/** The sidebar's list, before the targets have arrived: a couple of groups of rows. */
export function SidebarSkeleton() {
  return (
    <div className="space-y-1" aria-hidden="true">
      {[3, 2].map((rows, group) => (
        <div key={group}>
          <div className="flex h-[30px] items-center px-2">
            <Block className="h-2.5 w-24" />
          </div>
          <div className="ml-1 space-y-0.5">
            {Array.from({ length: rows }, (_, row) => (
              <div key={row} className="flex items-center gap-2.5 px-2 py-2">
                <Block className="h-2.5 w-2.5 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <Block className="my-0.5 h-4 w-32" />
                  <Block className="my-0.5 h-3 w-44" />
                </div>
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
