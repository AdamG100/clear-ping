'use client'

import { cn } from '@/lib/utils'

/**
 * Placeholders shaped like Routing's pages, for while they load: the same
 * cards and panels in the same places, so the page fills in where it stands
 * rather than jumping from a few grey lines to its real shape.
 */

const PANEL = 'min-w-0 rounded-3xl border border-border bg-card p-4 @2xl/main:p-6'

function Block({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)} style={style} />
}

/** A panel's title and the note beside it. */
function PanelHead({ title = 'w-32', note = 'w-48' }: { title?: string; note?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <Block className={`h-4 ${title}`} />
      <Block className={`h-3 max-w-full ${note}`} />
    </div>
  )
}

/** A watched prefix's card in the list: prefix and state, then its reach and upstreams, and its regions. */
function PrefixCardSkeleton() {
  return (
    <div className="flex flex-col gap-4 rounded-3xl border border-border bg-card p-4 @2xl/main:p-5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <Block className="h-5 w-40" />
          <Block className="mt-1.5 h-3 w-52 max-w-full" />
        </div>
        <Block className="h-6 w-20 rounded-full" />
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <Block className="h-3 w-48 max-w-full" />
          <Block className="h-2 w-full rounded-full" />
        </div>
        <div className="flex items-end gap-1">
          {[60, 90, 40, 75, 55].map(height => (
            <Block key={height} className="w-2.5" style={{ height: `${height * 0.32}px` }} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** The Routing page's list: the count, a card for each prefix, and your network. */
export function RoutingSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-busy="true">
      <span className="sr-only">Loading BGP monitoring</span>
      <div aria-hidden="true" className="space-y-4">
        <Block className="h-4 w-56" />
        <div className="grid gap-3 @2xl/main:gap-4 @5xl/main:grid-cols-2">
          {[0, 1, 2, 3].map(index => (
            <PrefixCardSkeleton key={index} />
          ))}
        </div>
        <div className={cn(PANEL, 'flex items-center gap-3')}>
          <Block className="size-9 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1">
            <Block className="h-4 w-56 max-w-full" />
            <Block className="mt-1.5 h-3 w-80 max-w-full" />
          </div>
          <Block className="h-8 w-20 rounded-lg" />
        </div>
      </div>
    </div>
  )
}

/** One vantage point's card in "From your networks": its name and network, then its timeline. */
function VantageSkeleton() {
  return (
    <div className="min-w-0 space-y-4 rounded-2xl border border-border p-4">
      <div className="flex items-start gap-3">
        <Block className="size-8 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <Block className="h-4 w-40" />
          <Block className="mt-1.5 h-3 w-56 max-w-full" />
        </div>
      </div>
      <div className="space-y-3">
        <Block className="h-3 w-24" />
        {[0, 1, 2].map(index => (
          <div key={index} className="flex gap-3">
            <Block className="size-6 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <Block className="h-3.5 w-3/4" />
              <Block className="mt-1.5 h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * A prefix's page: its header, the four figures, From your networks, where
 * it is seen and who carries it, the paths, the day's activity, what changed
 * and the collector peers.
 */
export function PrefixSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-4 @2xl/main:space-y-6">
      <span className="sr-only">Loading the prefix</span>
      <div aria-hidden="true" className="space-y-4 @2xl/main:space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <Block className="h-8 w-56 max-w-full" />
              <Block className="h-6 w-20 rounded-full" />
            </div>
            <Block className="mt-2 h-4 w-96 max-w-full" />
            <Block className="mt-2 h-3 w-72 max-w-full" />
          </div>
          <Block className="h-10 w-36 rounded-lg" />
        </div>

        <div className="grid grid-cols-2 gap-3 @2xl/main:gap-4 @5xl/main:grid-cols-4">
          {[0, 1, 2, 3].map(index => (
            <div key={index} className="rounded-3xl border border-border bg-card p-4 @2xl/main:p-5">
              <Block className="h-3 w-20" />
              <Block className="mt-3 h-8 w-16" />
              <Block className="mt-2 h-3 w-32 max-w-full" />
            </div>
          ))}
        </div>

        <div className={PANEL}>
          <PanelHead title="w-36" note="w-0" />
          <div className="mb-4 flex flex-wrap gap-2">
            {[0, 1, 2].map(index => (
              <Block key={index} className="h-7 w-32 rounded-full" />
            ))}
          </div>
          <div className="grid gap-4 @4xl/main:grid-cols-2">
            <VantageSkeleton />
            <VantageSkeleton />
          </div>
        </div>

        <Block className="h-11 w-full rounded-2xl" />

        <div className="grid gap-4 @5xl/main:grid-cols-2 @2xl/main:gap-6">
          <div className={PANEL}>
            <PanelHead />
            <div className="space-y-4">
              {[80, 65, 90, 40, 55].map(width => (
                <div key={width}>
                  <div className="flex justify-between">
                    <Block className="h-3.5 w-28" />
                    <Block className="h-3 w-14" />
                  </div>
                  <Block className="mt-2 h-2 rounded-full" style={{ width: `${width}%` }} />
                </div>
              ))}
            </div>
          </div>
          <div className={PANEL}>
            <PanelHead />
            <Block className="h-3 w-full rounded-full" />
            <div className="mt-4 space-y-3">
              {[0, 1, 2, 3, 4].map(index => (
                <div key={index} className="flex items-center gap-2.5">
                  <Block className="size-2.5 rounded-full" />
                  <Block className="h-3.5 flex-1" />
                  <Block className="h-3 w-16" />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={PANEL}>
          <PanelHead title="w-16" note="w-64" />
          {/* Four columns of nodes, as the paths are drawn. */}
          <div className="grid h-56 grid-cols-4 gap-6">
            {[4, 5, 3, 1].map((count, column) => (
              <div key={column} className="flex flex-col justify-center gap-3">
                {Array.from({ length: count }, (_, index) => (
                  <Block key={index} className="h-7 w-full rounded-lg" />
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className={PANEL}>
          <PanelHead title="w-20" note="w-72" />
          <div className="flex h-16 items-end gap-px">
            {Array.from({ length: 96 }, (_, index) => (
              <Block key={index} className="min-w-0 flex-1 rounded-sm" style={{ height: `${index % 11 === 3 ? 70 : index % 7 === 0 ? 30 : 4}%` }} />
            ))}
          </div>
          <div className="mt-4 space-y-2">
            {[0, 1, 2].map(index => (
              <Block key={index} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        </div>

        <div className={PANEL}>
          <PanelHead title="w-28" note="w-40" />
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map(index => (
              <Block key={index} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
