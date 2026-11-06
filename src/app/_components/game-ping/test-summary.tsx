'use client'

import { Alert } from '@/components/arc/alert/alert'
import { MetricCard } from '@/components/arc/metric-card/metric-card'
import { Progress } from '@/components/arc/progress/progress'
import { TextShimmer } from '@/components/arc/text-shimmer/text-shimmer'
import type { GameRegion } from '@/lib/game-ping/catalogue'
import type { Progress as TestProgress } from '@/lib/game-ping/results'
import type { ProbeId, ProbeSummary } from '@/types/probe-agent'

/**
 * What a run is doing, and what it found: which region is being pinged from
 * which probe as it happens, how far along it is, the fastest region from
 * each probe, and the regions nothing heard back from.
 */

const PANEL = 'rounded-3xl border border-border bg-card p-4 text-foreground @2xl/main:p-6'

/**
 * Names in a line, the first few of a long list and how many more: each is
 * marked in the list below too. Dots between, as the names have commas of
 * their own ("Tokyo, Japan").
 */
function listOf(names: string[]): string {
  if (names.length > 4) return `${names.slice(0, 3).join(' · ')} · and ${names.length - 3} more`
  return names.join(' · ')
}

/** What is being pinged now, as a line: the first of what is running, and how many more are. */
function nowPinging(progress: TestProgress, regionName: (id: string) => string, probeName: (id: ProbeId) => string): string {
  const [first, ...rest] = progress.running
  if (!first) return 'Starting'
  const line = `Pinging ${regionName(first.region)} from ${probeName(first.probe)}`
  return rest.length > 0 ? `${line}, and ${rest.length} more` : line
}

interface TestSummaryProps {
  testing: boolean
  progress: TestProgress
  regions: readonly GameRegion[]
  probes: readonly ProbeSummary[]
  fastest: ReadonlyMap<ProbeId, { region: GameRegion; latency: number }>
  silent: readonly GameRegion[]
}

export function TestSummary({ testing, progress, regions, probes, fastest, silent }: TestSummaryProps) {
  if (progress.total === 0) return null

  const regionName = (id: string) => regions.find(region => region.id === id)?.label ?? id
  const probeName = (id: ProbeId) => probes.find(probe => probe.id === id)?.name ?? id
  const regionCount = new Set(regions.map(region => region.id)).size
  const done = !testing && progress.finished === progress.total
  const heard = probes.filter(probe => fastest.has(probe.id))

  return (
    <section className={`${PANEL} space-y-4`} aria-label="Test">
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {testing ? (
            <TextShimmer as="p" className="min-w-0 text-sm font-medium">
              {nowPinging(progress, regionName, probeName)}
            </TextShimmer>
          ) : (
            <p className="text-sm font-medium">
              {done
                ? `Tested ${regionCount} region${regionCount === 1 ? '' : 's'} from ${probes.length} probe${probes.length === 1 ? '' : 's'}`
                : `Stopped after ${progress.finished} of ${progress.total} readings`}
            </p>
          )}
          <p className="text-xs text-muted-foreground">Median of 10 requests to each region</p>
        </div>
        <Progress label={`${progress.finished} of ${progress.total} readings`} value={progress.finished} max={progress.total} showValue />
        {/* Said once, when it finishes, rather than at every reading. */}
        <p className="sr-only" role="status" aria-live="polite">
          {done ? `Finished. ${silent.length > 0 ? `${silent.length} region${silent.length === 1 ? '' : 's'} did not reply.` : 'Every region replied.'}` : ''}
        </p>
      </div>

      {heard.length > 0 && (
        <div className="grid grid-cols-1 gap-3 @lg/main:grid-cols-2 @5xl/main:grid-cols-4">
          {heard.map(probe => {
            const best = fastest.get(probe.id)!
            return (
              <MetricCard key={probe.id} label={`Fastest from ${probe.name}`} value={Math.round(best.latency)} suffix=" ms" context={best.region.label} />
            )
          })}
        </div>
      )}

      {silent.length > 0 && (
        <Alert tone="warning" title={`${silent.length} region${silent.length === 1 ? '' : 's'} did not reply`}>
          No probe heard back from: {listOf(silent.map(region => region.label))}. A region may be down, moved, or not answering this kind of
          check from where your probes are. {testing ? 'More may follow as the test goes on.' : 'Test again to check.'}
        </Alert>
      )}
    </section>
  )
}
