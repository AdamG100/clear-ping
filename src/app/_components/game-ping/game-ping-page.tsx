'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Gamepad2, Play, Square } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { Button } from '@/components/arc/button/button'
import { EmptyState } from '@/components/arc/empty-state/empty-state'
import { Select } from '@/components/arc/select/select'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { CONTINENTS, methodLabel, probeFor, REGION_KIND_LABEL, type GameRegion, type GameSummary } from '@/lib/game-ping/catalogue'
import { fastestByProbe, fastestFirst, progressOf, silentRegions } from '@/lib/game-ping/results'
import type { ProbeSummary } from '@/types/probe-agent'
import { PANE, PANE_HEADER, PANE_TITLE } from '../dashboard/pane-layout'
import type { MonitorPreset } from '../targets/target-page'
import { RegionResults, type RegionSection } from './region-results'
import { TestSummary } from './test-summary'
import { getJson, useRegionTest } from './use-region-test'

/**
 * Game Server Ping: every region of a game, pinged from every probe, on demand.
 *
 * Nothing is kept. A region worth watching is one press from being a monitor,
 * which keeps its history, charts it and can raise alerts, as any other does.
 */

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const
const PANEL = 'rounded-3xl border border-border bg-card p-4 text-foreground @2xl/main:p-6'

type Order = 'region' | 'fastest'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The game, who publishes it, what its addresses are and where they came from. */
function GameAbout({ game }: { game: GameSummary }) {
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">{game.name}</h2>
        <span className="text-sm text-muted-foreground">{game.publisher}</span>
        <Badge size="sm" tone={game.what === 'cloud-region' ? 'warning' : 'info'}>
          {REGION_KIND_LABEL[game.what]}
        </Badge>
        {game.live && <Badge size="sm">Live list</Badge>}
      </div>
      {game.note && <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground">{game.note}</p>}
      {game.what === 'cloud-region' && (
        <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground">
          These are the cloud regions {game.name} is hosted in, not its game servers: a match runs on a machine in or near the region, so the
          time to the region is close to, but not exactly, the time in the game.
        </p>
      )}
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Source:</span>
        {game.sources.map(source => (
          <a
            key={source}
            href={source}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
          >
            {new URL(source).hostname}
            <ExternalLink {...ICON} size={12} />
          </a>
        ))}
      </p>
    </div>
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
  // The regions, with the game they belong to, so a new game shows none of the last one's while its own load.
  const [loaded, setLoaded] = useState<{ game: string; regions: GameRegion[] } | { game: string; error: string } | null>(null)
  const [order, setOrder] = useState<Order>('region')
  const { cells, testing, start, stop } = useRegionTest(game)

  // Only the probes that can be asked: an offline probe agent would fill its column with failures.
  const online = useMemo(() => probes.filter(probe => probe.local || probe.state === 'online'), [probes])
  const onlineIds = useMemo(() => online.map(probe => probe.id), [online])
  const offline = probes.length - online.length

  useEffect(() => {
    const abort = new AbortController()
    getJson<{ games: GameSummary[] }>('/api/game-ping', abort.signal)
      .then(body => setGames(body.games))
      .catch(error => !abort.signal.aborted && setGamesError(messageOf(error)))
    return () => abort.abort()
  }, [])

  useEffect(() => {
    if (!game) return
    const abort = new AbortController()
    getJson<{ regions: GameRegion[] }>(`/api/game-ping/${encodeURIComponent(game)}`, abort.signal)
      .then(body => setLoaded({ game, regions: body.regions }))
      .catch(error => !abort.signal.aborted && setLoaded({ game, error: messageOf(error) }))
    return () => abort.abort()
  }, [game])

  const current = loaded?.game === game ? loaded : null
  const regions = current && 'regions' in current ? current.regions : null
  const regionsError = current && 'error' in current ? current.error : null
  const about = games?.find(entry => entry.id === game) ?? null

  const progress = useMemo(() => progressOf(cells), [cells])
  const fastest = useMemo(() => fastestByProbe(regions ?? [], onlineIds, cells), [regions, onlineIds, cells])
  const silent = useMemo(() => silentRegions(regions ?? [], onlineIds, cells), [regions, onlineIds, cells])
  const silentIds = useMemo(() => new Set(silent.map(region => region.id)), [silent])

  const sections = useMemo((): RegionSection[] => {
    if (!regions) return []
    if (order === 'fastest') return [{ title: 'Fastest from any probe first', regions: fastestFirst(regions, onlineIds, cells) }]
    return CONTINENTS.map(continent => ({ title: continent, regions: regions.filter(region => region.continent === continent) })).filter(
      section => section.regions.length > 0
    )
  }, [regions, order, onlineIds, cells])

  const test = useCallback(() => {
    if (regions) void start(regions, onlineIds)
  }, [regions, onlineIds, start])

  const monitor = useCallback(
    (region: GameRegion) => {
      if (!about) return
      const { probeType, probeConfig } = probeFor(region.method)
      onMonitor({
        title: `Monitor ${about.name}, ${region.label}`,
        description: `${REGION_KIND_LABEL[about.what]} for ${about.name}, asked by ${methodLabel(region.method)}. Choose where to measure it from and how often, then add it.`,
        values: { name: `${about.name} ${region.label}`, host: region.host, probeType, probeConfig, ipVersion: 'ipv4', group: `Game Server Ping/${about.name}` },
      })
    },
    [about, onMonitor]
  )

  const canTest = Boolean(regions && regions.length > 0 && online.length > 0)

  return (
    <div className={PANE}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <h1 className={PANE_TITLE}>Game Server Ping</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            A game&apos;s regions, pinged from each of your probes, to see which one each of your networks reaches best. Nothing is kept: add a
            region as a monitor to keep its history.
          </p>
        </div>
      </header>

      {gamesError && (
        <Alert tone="danger" title="The list of games could not be loaded">
          {gamesError}
        </Alert>
      )}

      <section className={`${PANEL} space-y-4`} aria-label="Game">
        {/* The field and the button share a bottom edge: the field's label sits above it, not beside the button. */}
        <div className="flex flex-col gap-3 @xl/main:flex-row @xl/main:items-end">
          <div className="min-w-0 flex-1 @xl/main:max-w-md">
            <Select
              label="Game"
              placeholder={games ? 'Choose a game' : 'Loading games…'}
              value={game ?? ''}
              onValueChange={onPickGame}
              disabled={!games}
              options={(games ?? []).map(entry => ({ value: entry.id, label: entry.name }))}
            />
          </div>
          {testing ? (
            <Button type="button" variant="secondary" onClick={stop} className="w-full @xl/main:w-auto">
              <Square {...ICON} /> Stop
            </Button>
          ) : (
            <Button type="button" onClick={test} disabled={!canTest} className="w-full @xl/main:w-auto">
              <Play {...ICON} /> {progress.total > 0 ? 'Test again' : 'Test'}
            </Button>
          )}
        </div>
        {about && <GameAbout game={about} />}
      </section>

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
          {/* One note about the probes, not two stacked: which are left out, and what another would add. */}
          {online.length === 1 && (offline > 0 || onAddProbeAgent) ? (
            <Alert tone="info" title="Measured from the local probe only">
              {offline > 0
                ? `${offline} probe agent${offline === 1 ? ' is' : 's are'} offline, so ${offline === 1 ? 'it is' : 'they are'} not asked. `
                : 'A probe agent in another place, a friend’s house or a VPS abroad, adds a column, so you can compare routes. '}
              {onAddProbeAgent && (
                <button type="button" onClick={onAddProbeAgent} className="underline underline-offset-2">
                  {offline > 0 ? 'Probe agents' : 'Add a probe agent'}
                </button>
              )}
            </Alert>
          ) : (
            offline > 0 && (
              <Alert tone="info" title={`${offline} probe agent${offline === 1 ? ' is' : 's are'} offline`}>
                Only the probes that are online are asked.
              </Alert>
            )
          )}
          {regionsError && (
            <Alert tone="danger" title="The regions could not be loaded">
              {regionsError}
            </Alert>
          )}

          {regions && <TestSummary testing={testing} progress={progress} regions={regions} probes={online} fastest={fastest} silent={silent} />}

          {!regions && !regionsError && (
            <section className={PANEL}>
              <Skeleton label="Loading regions" lines={6} />
            </section>
          )}

          {regions && regions.length > 0 && (
            <section className={`${PANEL} space-y-4`} aria-label="Regions">
              <div className="flex flex-col gap-3 @xl/main:flex-row @xl/main:items-center @xl/main:justify-between">
                <p className="text-sm text-muted-foreground">
                  {regions.length} region{regions.length === 1 ? '' : 's'} · {online.length} probe{online.length === 1 ? '' : 's'}
                  {progress.total === 0 && ' · press Test to ping them'}
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
              <RegionResults
                sections={sections}
                probes={online}
                cells={cells}
                fastest={fastest}
                silent={silentIds}
                onMonitor={readOnly ? undefined : monitor}
              />
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
