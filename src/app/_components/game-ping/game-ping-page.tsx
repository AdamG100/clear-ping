'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Gamepad2, Loader2, Play, Plus, Square } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Select } from '@/components/arc/select/select'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { getLatencyColor } from '@/lib/charts/packet-loss-colors'
import { CONTINENTS, methodLabel, probeFor, REGION_KIND_LABEL, type GameRegion, type GameSummary, type RegionReading } from '@/lib/game-ping/catalogue'
import type { ProbeId, ProbeSummary } from '@/types/probe-agent'
import { PANE, PANE_ACTION, PANE_ACTIONS, PANE_HEADER, PANE_TITLE } from '../dashboard/pane-layout'
import type { MonitorPreset } from '../targets/target-page'

/**
 * Game Server Ping: every region of a game, pinged from every probe, on demand.
 *
 * Nothing is kept. A region worth watching is one press from being a monitor,
 * which keeps its history, charts it and can raise alerts, as any other does.
 */

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const
const PANEL = 'rounded-3xl border border-border bg-card p-4 text-foreground @2xl/main:p-6'

/** Tests the page has running at once. The dashboard has a limit of its own across everyone. */
const AT_ONCE = 4

type Cell = { state: 'running' } | { state: 'done'; reading: RegionReading } | { state: 'failed'; error: string }
const cellKey = (region: string, probe: ProbeId) => `${region}|${probe}`

type Order = 'region' | 'fastest'

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error((body as { error?: string } | null)?.error ?? `The dashboard answered ${response.status}`)
  return body as T
}

function ReadingCell({ cell, best }: { cell: Cell | undefined; best: boolean }) {
  if (!cell) return <span className="text-muted-foreground">·</span>
  if (cell.state === 'running') return <Loader2 {...ICON} size={14} className="animate-spin text-muted-foreground motion-reduce:animate-none" />
  if (cell.state === 'failed') {
    return (
      <Tooltip content={cell.error}>
        <span className="text-signal-critical">Failed</span>
      </Tooltip>
    )
  }
  const { latency, loss, jitter, error, address } = cell.reading
  if (latency === null) {
    return (
      <Tooltip content={error ?? 'Nothing answered'}>
        <span className="text-signal-critical">No reply</span>
      </Tooltip>
    )
  }
  const detail = [`${latency} ms median`, jitter !== null ? `${jitter} ms jitter` : null, `${loss}% unanswered`, address ? `at ${address}` : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <Tooltip content={detail}>
      <span className="inline-flex items-baseline gap-1.5 font-mono tabular-nums">
        <span style={{ color: getLatencyColor(latency) }} className={best ? 'font-semibold' : undefined}>
          {Math.round(latency)} ms
        </span>
        {loss > 0 && <span className="text-xs text-signal-moderate">{loss}%</span>}
      </span>
    </Tooltip>
  )
}

interface GamePingPageProps {
  /** The game in the address, if one was picked. */
  game?: string
  probes: ProbeSummary[]
  readOnly: boolean
  onPickGame: (game: string) => void
  /** Open the add-monitor form, started from a region. */
  onMonitor: (preset: MonitorPreset) => void
  onAddProbeAgent?: () => void
}

export function GamePingPage({ game, probes, readOnly, onPickGame, onMonitor, onAddProbeAgent }: GamePingPageProps) {
  const [games, setGames] = useState<GameSummary[] | null>(null)
  const [gamesError, setGamesError] = useState<string | null>(null)
  const [regions, setRegions] = useState<GameRegion[] | null>(null)
  const [regionsError, setRegionsError] = useState<string | null>(null)
  const [cells, setCells] = useState<Record<string, Cell>>({})
  const [testing, setTesting] = useState(false)
  const [order, setOrder] = useState<Order>('region')
  const run = useRef<AbortController | null>(null)

  // Only the probes that can be asked: an offline probe agent would fill its column with failures.
  const online = useMemo(() => probes.filter(probe => probe.local || probe.state === 'online'), [probes])
  const offline = probes.length - online.length

  useEffect(() => {
    const abort = new AbortController()
    getJson<{ games: GameSummary[] }>('/api/game-ping', abort.signal)
      .then(body => setGames(body.games))
      .catch(error => !abort.signal.aborted && setGamesError(error instanceof Error ? error.message : String(error)))
    return () => abort.abort()
  }, [])

  const stop = useCallback(() => {
    run.current?.abort()
    run.current = null
    setTesting(false)
    setCells(current => Object.fromEntries(Object.entries(current).filter(([, cell]) => cell.state !== 'running')))
  }, [])

  // A new game starts clean: its regions, and none of the last game's numbers.
  useEffect(() => {
    stop()
    setCells({})
    setRegions(null)
    setRegionsError(null)
    if (!game) return
    const abort = new AbortController()
    getJson<{ regions: GameRegion[] }>(`/api/game-ping/${encodeURIComponent(game)}`, abort.signal)
      .then(body => setRegions(body.regions))
      .catch(error => !abort.signal.aborted && setRegionsError(error instanceof Error ? error.message : String(error)))
    return () => abort.abort()
  }, [game, stop])

  useEffect(() => () => run.current?.abort(), [])

  const test = useCallback(async () => {
    if (!game || !regions) return
    run.current?.abort()
    const abort = new AbortController()
    run.current = abort
    setTesting(true)
    setCells({})

    // Region by region, so the grid fills from the top, each across every probe.
    const jobs = regions.flatMap(region => online.map(probe => ({ region: region.id, probe: probe.id })))
    let next = 0
    const worker = async () => {
      while (!abort.signal.aborted && next < jobs.length) {
        const { region, probe } = jobs[next++]
        const key = cellKey(region, probe)
        setCells(current => ({ ...current, [key]: { state: 'running' } }))
        try {
          const query = new URLSearchParams({ region, probe })
          const reading = await getJson<RegionReading>(`/api/game-ping/${encodeURIComponent(game)}/test?${query}`, abort.signal)
          setCells(current => ({ ...current, [key]: { state: 'done', reading } }))
        } catch (error) {
          if (abort.signal.aborted) return
          setCells(current => ({ ...current, [key]: { state: 'failed', error: error instanceof Error ? error.message : String(error) } }))
        }
      }
    }
    await Promise.all(Array.from({ length: AT_ONCE }, worker))
    if (run.current === abort) {
      run.current = null
      setTesting(false)
    }
  }, [game, regions, online])

  const current = games?.find(entry => entry.id === game) ?? null

  // The fastest answer from each probe, marked in its column.
  const best = useMemo(() => {
    const fastest = new Map<ProbeId, { region: string; latency: number }>()
    for (const [key, cell] of Object.entries(cells)) {
      if (cell.state !== 'done' || cell.reading.latency === null) continue
      const [region, probe] = key.split('|')
      const known = fastest.get(probe)
      if (!known || cell.reading.latency < known.latency) fastest.set(probe, { region, latency: cell.reading.latency })
    }
    return fastest
  }, [cells])

  const latencyOf = useCallback(
    (region: string) => {
      const cell = online[0] && cells[cellKey(region, online[0].id)]
      return cell?.state === 'done' && cell.reading.latency !== null ? cell.reading.latency : Number.POSITIVE_INFINITY
    },
    [cells, online]
  )

  const sections = useMemo(() => {
    if (!regions) return []
    if (order === 'fastest') {
      return [{ title: `Fastest from ${online[0]?.name ?? 'the first probe'}`, regions: [...regions].sort((a, b) => latencyOf(a.id) - latencyOf(b.id)) }]
    }
    return CONTINENTS.map(continent => ({ title: continent, regions: regions.filter(region => region.continent === continent) })).filter(
      section => section.regions.length > 0
    )
  }, [regions, order, online, latencyOf])

  const monitor = (region: GameRegion) => {
    if (!current) return
    const { probeType, probeConfig } = probeFor(region.method)
    onMonitor({
      title: `Monitor ${current.name}, ${region.label}`,
      description: `${REGION_KIND_LABEL[current.what]} for ${current.name}, asked by ${methodLabel(region.method)}. Choose where to measure it from and how often, then add it.`,
      values: { name: `${current.name} ${region.label}`, host: region.host, probeType, probeConfig, ipVersion: 'ipv4', group: `Game Server Ping/${current.name}` },
    })
  }

  return (
    <div className={PANE}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <h1 className={PANE_TITLE}>Game Server Ping</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A game&apos;s regions, pinged from each of your probes. Nothing is kept: add a region as a monitor to keep its history.
          </p>
        </div>
        <div className={PANE_ACTIONS}>
          <div className="min-w-56 flex-1 @3xl/main:flex-none">
            <Select
              label="Game"
              placeholder={games ? 'Choose a game' : 'Loading games…'}
              value={game ?? ''}
              onValueChange={onPickGame}
              disabled={!games}
              options={(games ?? []).map(entry => ({ value: entry.id, label: entry.name }))}
            />
          </div>
          <div className={PANE_ACTION}>
            {testing ? (
              <Button type="button" variant="secondary" onClick={stop}>
                <Square {...ICON} /> Stop
              </Button>
            ) : (
              <Button type="button" onClick={test} disabled={!regions || regions.length === 0 || online.length === 0}>
                <Play {...ICON} /> {Object.keys(cells).length > 0 ? 'Test again' : 'Test'}
              </Button>
            )}
          </div>
        </div>
      </header>

      {gamesError && <Alert tone="danger" title="The list of games could not be loaded">{gamesError}</Alert>}

      {!game ? (
        <section className={PANEL}>
          <EmptyState
            icon={<Gamepad2 {...ICON} size={20} />}
            title="Choose a game"
            description="Each of its regions is pinged from the local probe and every probe agent that is online, side by side, so you can see which region each of your networks reaches best."
          />
        </section>
      ) : (
        <>
          {current && (
            <section className={`${PANEL} space-y-3`}>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-medium">{current.name}</h2>
                <span className="text-sm text-muted-foreground">{current.publisher}</span>
                <Badge size="sm" tone={current.what === 'cloud-region' ? 'warning' : 'info'}>{REGION_KIND_LABEL[current.what]}</Badge>
                {current.live && <Badge size="sm">Live list</Badge>}
              </div>
              {current.note && <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground">{current.note}</p>}
              {current.what === 'cloud-region' && (
                <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground">
                  These are the cloud regions {current.name} is hosted in, not its game servers: a match runs on a machine in or near the
                  region, so the time to the region is close to, but not exactly, the time in the game.
                </p>
              )}
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>Source:</span>
                {current.sources.map(source => (
                  <a key={source} href={source} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline">
                    {new URL(source).hostname}
                    <ExternalLink {...ICON} size={12} />
                  </a>
                ))}
              </p>
            </section>
          )}

          {offline > 0 && (
            <Alert tone="info" title={`${offline} probe agent${offline === 1 ? ' is' : 's are'} offline`}>
              Only the probes that are online are asked.
            </Alert>
          )}
          {online.length === 1 && onAddProbeAgent && (
            <Alert tone="info" title="Measured from the local probe only">
              A probe agent in another place, a friend&apos;s house or a VPS abroad, adds a column, so you can compare routes.{' '}
              <button type="button" onClick={onAddProbeAgent} className="underline underline-offset-2">
                Add a probe agent
              </button>
              .
            </Alert>
          )}
          {regionsError && <Alert tone="danger" title="The regions could not be loaded">{regionsError}</Alert>}

          {regions && regions.length > 0 && (
            <section className={`${PANEL} space-y-4`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {regions.length} region{regions.length === 1 ? '' : 's'} · median of 10 requests each
                </p>
                <SegmentedControl
                  label="Order"
                  value={order}
                  onValueChange={value => setOrder(value as Order)}
                  options={[
                    { value: 'region', label: 'By continent' },
                    { value: 'fastest', label: 'Fastest first' },
                  ]}
                />
              </div>
              {/* The table scrolls inside its card when there are more probes than room. */}
              <div className="-mx-4 overflow-x-auto px-4 @2xl/main:-mx-6 @2xl/main:px-6">
                <table className="w-full min-w-[36rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" className="py-2 pr-4 font-medium">Region</th>
                      {online.map(probe => (
                        <th key={probe.id} scope="col" className="px-3 py-2 text-right font-medium">
                          {probe.name}
                        </th>
                      ))}
                      {!readOnly && <th scope="col" className="w-0 py-2 pl-3"><span className="sr-only">Monitor</span></th>}
                    </tr>
                  </thead>
                  {sections.map(section => (
                    <tbody key={section.title}>
                      <tr>
                        <th scope="rowgroup" colSpan={online.length + 2} className="pt-4 pb-1 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {section.title}
                        </th>
                      </tr>
                      {section.regions.map(region => (
                        <tr key={region.id} className="border-b border-border/60 last:border-b-0">
                          <th scope="row" className="py-2 pr-4 text-left font-normal">
                            <span className="block">{region.label}</span>
                            <span className="block font-mono text-xs text-muted-foreground">
                              {region.host} · {methodLabel(region.method)}
                            </span>
                          </th>
                          {online.map(probe => (
                            <td key={probe.id} className="px-3 py-2 text-right">
                              <ReadingCell cell={cells[cellKey(region.id, probe.id)]} best={best.get(probe.id)?.region === region.id} />
                            </td>
                          ))}
                          {!readOnly && (
                            <td className="py-2 pl-3 text-right">
                              <Tooltip content="Add it as a monitor, to keep its history and alert on it">
                                <Button type="button" variant="ghost" size="sm" onClick={() => monitor(region)} aria-label={`Monitor ${region.label}`}>
                                  <Plus {...ICON} />
                                </Button>
                              </Tooltip>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              </div>
            </section>
          )}
          {regions && regions.length === 0 && (
            <section className={PANEL}>
              <EmptyState title="No regions listed" description="The list this game's regions come from has none at the moment." />
            </section>
          )}
        </>
      )}
    </div>
  )
}
