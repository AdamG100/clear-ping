'use client'

import { memo } from 'react'
import { Plus } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { TextShimmer } from '@/components/arc/text-shimmer/text-shimmer'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { getLatencyColor } from '@/lib/charts/packet-loss-colors'
import { methodLabel, type GameRegion } from '@/lib/game-ping/catalogue'
import { cellKey, type Cell, type Cells } from '@/lib/game-ping/results'
import type { ProbeId, ProbeSummary } from '@/types/probe-agent'
import { cn } from '@/lib/utils'

/**
 * The regions of a game and what each probe measured to them: a table where
 * the pane is wide enough for a column per probe, and a card per region where
 * it is not, so a phone never scrolls sideways to find a number.
 */

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

export interface RegionSection {
  title: string
  regions: GameRegion[]
}

interface RegionResultsProps {
  sections: RegionSection[]
  probes: ProbeSummary[]
  cells: Cells
  /** The quickest region from each probe. */
  fastest: ReadonlyMap<ProbeId, { region: GameRegion }>
  /** Regions no probe heard back from. */
  silent: ReadonlySet<string>
  /** Without it, a viewer, there is no button to add a region as a monitor. */
  onMonitor?: (region: GameRegion) => void
}

/** How long, how much went unanswered, and the address it went to, said in a line. */
function detailOf(cell: Extract<Cell, { state: 'done' }>, withLatency = true): string {
  const { latency, loss, jitter, address } = cell.reading
  return [withLatency && latency !== null ? `${latency} ms median` : null, jitter !== null ? `${jitter} ms jitter` : null, `${loss}% unanswered`, address ? `at ${address}` : null]
    .filter(Boolean)
    .join(' · ')
}

/** One region from one probe. `detailed` spells out what the table keeps in a tooltip, for a phone, which has no hover. */
function Reading({ cell, fastest, detailed = false }: { cell: Cell | undefined; fastest: boolean; detailed?: boolean }) {
  if (!cell) return <span className="text-muted-foreground">·</span>
  if (cell.state === 'queued') return <span className="text-xs text-muted-foreground">Waiting</span>
  if (cell.state === 'running') return <TextShimmer className="text-xs">Pinging</TextShimmer>
  if (cell.state === 'failed') {
    const label = <span className="text-xs text-signal-moderate">Not tested</span>
    return detailed ? (
      <span className="flex flex-col items-end gap-0.5 text-right">
        {label}
        <span className="text-xs text-muted-foreground">{cell.error}</span>
      </span>
    ) : (
      <Tooltip content={cell.error}>{label}</Tooltip>
    )
  }

  const { latency, loss, error } = cell.reading
  if (latency === null) {
    const badge = (
      <Badge size="sm" tone="danger">
        No reply
      </Badge>
    )
    return detailed ? (
      <span className="flex flex-col items-end gap-0.5 text-right">
        {badge}
        {error && <span className="text-xs text-muted-foreground">{error}</span>}
      </span>
    ) : (
      <Tooltip content={error ?? 'Nothing answered'}>
        <span>{badge}</span>
      </Tooltip>
    )
  }

  const value = (
    <span className="inline-flex items-center justify-end gap-1.5 font-mono tabular-nums">
      {fastest && (
        <Badge size="sm" tone="success">
          Fastest
        </Badge>
      )}
      <span style={{ color: getLatencyColor(latency) }} className={fastest ? 'font-medium' : undefined}>
        {Math.round(latency)} ms
      </span>
      {loss > 0 && <span className="text-xs text-signal-moderate">{loss}% lost</span>}
    </span>
  )
  return detailed ? (
    <span className="flex flex-col items-end gap-0.5 text-right">
      {value}
      {/* The number above is the median already. */}
      <span className="text-xs text-muted-foreground">{detailOf(cell, false)}</span>
    </span>
  ) : (
    <Tooltip content={detailOf(cell)}>{value}</Tooltip>
  )
}

function RegionName({ region, silent }: { region: GameRegion; silent: boolean }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-2">
        <span className={cn('font-medium', silent && 'text-muted-foreground')}>{region.label}</span>
        {silent && (
          <Badge size="sm" tone="danger">
            No probe got a reply
          </Badge>
        )}
      </span>
      <span className="break-all font-mono text-xs text-muted-foreground">
        {region.host} · {methodLabel(region.method)}
      </span>
    </span>
  )
}

function MonitorButton({ region, onMonitor }: { region: GameRegion; onMonitor: (region: GameRegion) => void }) {
  return (
    <Tooltip content="Add it as a monitor, to keep its history and alert on it">
      <Button type="button" variant="ghost" size="sm" onClick={() => onMonitor(region)} aria-label={`Monitor ${region.label}`}>
        <Plus {...ICON} />
      </Button>
    </Tooltip>
  )
}

function Table({ sections, probes, cells, fastest, silent, onMonitor }: RegionResultsProps) {
  return (
    // More probes than room: the table scrolls inside its card, the page does not.
    <div className="-mx-6 overflow-x-auto px-6">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-medium">
              Region
            </th>
            {probes.map(probe => (
              <th key={probe.id} scope="col" className="min-w-32 px-3 py-2 text-right font-medium">
                {probe.name}
              </th>
            ))}
            {onMonitor && (
              <th scope="col" className="w-0 py-2 pl-3">
                <span className="sr-only">Monitor</span>
              </th>
            )}
          </tr>
        </thead>
        {sections.map(section => (
          <tbody key={section.title}>
            <tr>
              <th scope="rowgroup" colSpan={probes.length + 2} className="pt-5 pb-1.5 text-left text-xs font-medium text-muted-foreground">
                {section.title}
              </th>
            </tr>
            {section.regions.map(region => (
              <tr key={region.id} className={cn('border-b border-border/60 last:border-b-0', silent.has(region.id) && 'bg-signal-critical/5')}>
                <th scope="row" className="py-2.5 pr-4 text-left font-normal">
                  <RegionName region={region} silent={silent.has(region.id)} />
                </th>
                {probes.map(probe => (
                  <td key={probe.id} className="px-3 py-2.5 text-right">
                    <Reading cell={cells.get(cellKey(region.id, probe.id))} fastest={fastest.get(probe.id)?.region.id === region.id} />
                  </td>
                ))}
                {onMonitor && (
                  <td className="py-2.5 pl-3 text-right">
                    <MonitorButton region={region} onMonitor={onMonitor} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}

function Cards({ sections, probes, cells, fastest, silent, onMonitor }: RegionResultsProps) {
  return (
    <div className="space-y-5">
      {sections.map(section => (
        <section key={section.title} aria-label={section.title} className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">{section.title}</h3>
          <ul className="space-y-2">
            {section.regions.map(region => (
              <li
                key={region.id}
                className={cn('rounded-2xl border border-border p-3', silent.has(region.id) ? 'border-signal-critical/30 bg-signal-critical/5' : 'bg-background/40')}
              >
                <div className="flex items-start justify-between gap-2">
                  <RegionName region={region} silent={silent.has(region.id)} />
                  {onMonitor && <MonitorButton region={region} onMonitor={onMonitor} />}
                </div>
                <dl className="mt-2 divide-y divide-border/60">
                  {probes.map(probe => (
                    <div key={probe.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                      <dt className="max-w-[45%] shrink-0 truncate pt-0.5 text-muted-foreground">{probe.name}</dt>
                      {/* The details under the number wrap here, rather than push the card wider than the phone. */}
                      <dd className="min-w-0 break-words">
                        <Reading cell={cells.get(cellKey(region.id, probe.id))} fastest={fastest.get(probe.id)?.region.id === region.id} detailed />
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** Both layouts, the one that fits shown. Hidden, the other is left out of the page for a screen reader too. */
export const RegionResults = memo(function RegionResults(props: RegionResultsProps) {
  return (
    <>
      <div className="hidden @2xl/main:block">
        <Table {...props} />
      </div>
      <div className="@2xl/main:hidden">
        <Cards {...props} />
      </div>
    </>
  )
})
