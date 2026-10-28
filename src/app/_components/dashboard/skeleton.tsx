'use client'

import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { cn } from '@/lib/utils'
import { PANE, PANE_HEADER } from './pane-layout'
import { STAT_GRID, STAT_GRID_LEAD } from '../targets/stats-cards'

/**
 * Placeholders shaped like the content they stand in for.
 *
 * Switching targets used to replace the whole pane with a centred spinner,
 * which collapsed the layout and then rebuilt it a moment later — the page
 * visibly jumped twice per click. Holding the same shape means only the values
 * change, so the eye stays where it was.
 */

function Block({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`animate-pulse rounded-md bg-muted motion-reduce:animate-none ${className}`} style={style} />
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
            '@container/card rounded-3xl border border-border bg-card p-4 @2xl/main:p-6',
            i === 0 && STAT_GRID_LEAD
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <Block className="h-5 w-28" />
            <Block className="h-6 w-16 rounded-full" />
          </div>
          <Block className="mt-4 h-9 w-32 @2xl/main:mt-5" />
          <Block className="mt-2 h-3 w-40" />
          {/* The bar of the spread with its ends and key under it, or of loss with its key. */}
          <Block className="mt-4 h-5 w-full rounded-full @2xl/main:mt-5" />
          <Block className="mt-1.5 h-3.5 w-full" />
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 @2xs/card:grid-cols-3">
            {/* As tall as a label over a figure, so the cards do not grow when
                the figures arrive and push the chart down the page. */}
            {[0, 1, 2].map(j => (
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

      <section className="min-h-[26rem] rounded-3xl border border-border bg-card p-4 @2xl/main:p-6" aria-hidden="true">
        <div className="mb-4">
          <Block className="h-5 w-40" />
          <Block className="mt-0.5 h-4 w-80 max-w-full" />
        </div>
        <TraceSkeleton />
      </section>
    </div>
  )
}

const PANEL = 'rounded-3xl border border-border bg-card p-4 @2xl/main:p-6'

/** A panel's title, with a note across from it when it has one. */
function PanelTitle({ note = false }: { note?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <Block className="h-4 w-36" />
      {note && <Block className="h-3 w-48 max-w-full" />}
    </div>
  )
}

/**
 * The day on the overview, before /api/overview has answered: the strip of
 * the last 24 hours with its times and key, then what happened beside the
 * least reliable. It comes later than the rest of the page, which has the
 * readings already.
 */
export function OverviewDaySkeleton() {
  return (
    <div className="space-y-4 @2xl/main:space-y-6" role="status" aria-busy="true">
      <span className="sr-only">Reading the last 24 hours</span>
      <section className={PANEL} aria-hidden="true">
        <PanelTitle note />
        <Block className="mt-4 h-8 w-full rounded-sm @xl/main:h-10" />
        <div className="mt-1.5 flex h-4 justify-around">
          {[0, 1, 2, 3].map(tick => (
            <Block key={tick} className="h-3 w-10" />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {[24, 32, 36, 24].map((width, index) => (
            <Block key={index} className="h-3" style={{ width: `${width * 0.25}rem` }} />
          ))}
        </div>
      </section>
      <div className="grid items-start gap-4 @2xl/main:gap-6 @5xl/main:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className={PANEL} aria-hidden="true">
          <PanelTitle />
          <Block className="mt-4 h-4 w-20" />
          <div className="mt-3 space-y-4">
            {[0, 1, 2, 3].map(row => (
              <div key={row} className="flex gap-3">
                <Block className="size-6 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <Block className="h-3.5 w-2/3" />
                  <Block className="mt-1.5 h-3 w-5/6" />
                </div>
                <Block className="h-3 w-10 shrink-0" />
              </div>
            ))}
          </div>
        </section>
        <section className={PANEL} aria-hidden="true">
          <PanelTitle />
          <div className="mt-4 divide-y divide-border">
            {[0, 1, 2, 3, 4].map(row => (
              <div key={row} className="flex items-center justify-between gap-3 py-2.5">
                <Block className="h-3.5 w-32" />
                <Block className="h-3 w-24" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

/**
 * The overview before the targets have arrived: its headline, the four
 * figures, the network's tiles and the day. Shown instead of the page with
 * nothing in it yet, whose figures read 0 of 0 and whose headline said it was
 * waiting for the first readings, before every number changed at once.
 */
export function OverviewSkeleton() {
  return (
    <div className="space-y-4 @2xl/main:space-y-6" role="status" aria-busy="true">
      <span className="sr-only">Loading the overview</span>
      <div aria-hidden="true" className="space-y-4 @2xl/main:space-y-6">
        {/* The headline: an alert's icon, title and a line under it. */}
        <div className="flex gap-3 rounded-2xl border border-border bg-card p-4">
          <Block className="size-5 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <Block className="h-5 w-48 max-w-full" />
            <Block className="mt-2.5 h-3.5 w-80 max-w-full" />
          </div>
        </div>

        {/* As the figures fold: two by two on a phone, four abreast when wide. */}
        <div className="grid grid-cols-2 gap-3 @2xl/main:gap-4 @5xl/main:grid-cols-4">
          {[0, 1, 2, 3].map(card => (
            <div key={card} className="min-w-0 rounded-3xl border border-border bg-card p-4 @2xl/main:p-6">
              <Block className="h-5 w-24 max-w-full" />
              <Block className="mt-8 h-10 w-14" />
              <Block className="mt-4 h-4 w-36 max-w-full" />
            </div>
          ))}
        </div>

        <section className={PANEL}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Block className="h-4 w-28" />
            <div className="flex gap-1.5">
              {[0, 1, 2].map(kind => (
                <Block key={kind} className="h-5 w-14 rounded-full" />
              ))}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 @3xl/main:grid-cols-3 @6xl/main:grid-cols-4 @[100rem]/main:grid-cols-6">
            {[0, 1, 2, 3, 4, 5].map(tile => (
              <div key={tile} className="flex flex-col gap-2 rounded-2xl border border-border p-3">
                <div className="flex items-center gap-2">
                  <Block className="size-2.5 shrink-0 rounded-full" />
                  <Block className="h-4 w-24 max-w-full" />
                </div>
                <Block className="h-3 w-32 max-w-full" />
                <Block className="h-3 w-20" />
              </div>
            ))}
          </div>
        </section>
      </div>
      <OverviewDaySkeleton />
    </div>
  )
}

/** The sidebar's list, before the targets have arrived: a few rows of a name and an address each. */
export function SidebarSkeleton() {
  return (
    <div className="space-y-4 px-2 py-1">
      {[0, 1, 2, 3, 4].map(row => (
        <Skeleton key={row} label="Loading the targets" lines={2} />
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
