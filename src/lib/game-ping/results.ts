import type { ProbeId } from '@/types/probe-agent'
import type { GameRegion, RegionReading } from './catalogue'

/**
 * What a run of Game Server Ping has found so far: one cell for each region
 * and probe, and what the page says about them. Pure, for the page and its tests.
 */

export type Cell =
  /** Waiting its turn: the page runs a few tests at once. */
  | { state: 'queued' }
  | { state: 'running' }
  | { state: 'done'; reading: RegionReading }
  /** The dashboard could not run the test at all, as against the region not answering. */
  | { state: 'failed'; error: string }

export type Cells = ReadonlyMap<string, Cell>

export const cellKey = (region: string, probe: ProbeId) => `${region}\n${probe}`

/** A reading that came back with a time. */
export function answered(cell: Cell | undefined): cell is { state: 'done'; reading: RegionReading & { latency: number } } {
  return cell?.state === 'done' && cell.reading.latency !== null
}

/** Asked, and nothing came back. */
export function unanswered(cell: Cell | undefined): boolean {
  return cell?.state === 'done' && cell.reading.latency === null
}

export interface Progress {
  total: number
  /** Answered, unanswered or failed: everything that is no longer waiting or running. */
  finished: number
  running: { region: string; probe: ProbeId }[]
}

export function progressOf(cells: Cells): Progress {
  const running: Progress['running'] = []
  let finished = 0
  for (const [key, cell] of cells) {
    if (cell.state === 'running') {
      const [region, probe] = key.split('\n')
      running.push({ region, probe })
    } else if (cell.state !== 'queued') {
      finished++
    }
  }
  return { total: cells.size, finished, running }
}

/** The quickest region from each probe, of those that answered it. */
export function fastestByProbe(regions: readonly GameRegion[], probes: readonly ProbeId[], cells: Cells): Map<ProbeId, { region: GameRegion; latency: number }> {
  const fastest = new Map<ProbeId, { region: GameRegion; latency: number }>()
  for (const probe of probes) {
    for (const region of regions) {
      const cell = cells.get(cellKey(region.id, probe))
      if (!answered(cell)) continue
      const known = fastest.get(probe)
      if (!known || cell.reading.latency < known.latency) fastest.set(probe, { region, latency: cell.reading.latency })
    }
  }
  return fastest
}

/**
 * The regions every probe asked and none heard back from. A region still
 * being asked anywhere, or one the dashboard could not ask, is not counted:
 * that says nothing about the region.
 */
export function silentRegions(regions: readonly GameRegion[], probes: readonly ProbeId[], cells: Cells): GameRegion[] {
  if (probes.length === 0) return []
  return regions.filter(region => probes.every(probe => unanswered(cells.get(cellKey(region.id, probe)))))
}

/** The quickest time to a region from any probe, for putting the fastest first. Unanswered go last. */
export function bestLatency(region: string, probes: readonly ProbeId[], cells: Cells): number {
  let best = Number.POSITIVE_INFINITY
  for (const probe of probes) {
    const cell = cells.get(cellKey(region, probe))
    if (answered(cell) && cell.reading.latency < best) best = cell.reading.latency
  }
  return best
}

/** The regions, fastest from any probe first. Stable, so regions not yet measured keep their order. */
export function fastestFirst(regions: readonly GameRegion[], probes: readonly ProbeId[], cells: Cells): GameRegion[] {
  return regions
    .map((region, index) => ({ region, index, latency: bestLatency(region.id, probes, cells) }))
    .sort((a, b) => a.latency - b.latency || a.index - b.index)
    .map(entry => entry.region)
}
