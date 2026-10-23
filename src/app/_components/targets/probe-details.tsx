import { Alert } from '@/components/arc/alert/alert'
import { Badge } from '@/components/arc/badge/badge'
import { SortableDataTable } from '@/components/arc/sortable-data-table/sortable-data-table'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { cn } from '@/lib/utils'
import { DNS_PROTOCOL_LABEL, DNS_PROTOCOL_NAME, readingName } from '@/lib/probes/dns/resolvers'
import { resolversThatDiffer } from '@/lib/charts/dns-resolver-series'
import { getPacketLossVar, NO_REPLY_COLOR } from '@/lib/charts/packet-loss-colors'
import { LossFigure } from '../charts/loss-figure'
import type { DnsResolver, DnsResolverReading, GameServerInfo, LatestMeasurement, ProbeDetails, ProbeType } from '@/types/probe'
import { inDisplayZone } from '@/lib/time-zone'

/**
 * What the latest probe learned beyond its timings.
 *
 * The three stat cards say how long and how often; this says what actually
 * came back — the status a web server answered with, where the time went
 * inside the request, how long its certificate has left, what a DNS query
 * resolved to, who is playing on a game server — and, when the probe failed, why. A target that shows 100%
 * loss for "connection refused" and one that shows it for "certificate has
 * expired" need completely different fixes.
 */

const DAY_MS = 24 * 60 * 60 * 1000

interface ProbeDetailsPanelProps {
  probeType: ProbeType
  latest: Omit<LatestMeasurement, 'byFamily'> | undefined
  /** Names which probe this is, where a target has more than one. */
  label?: string
  /** dns: the resolvers the target asks now, which is what their readings are named from. */
  resolverList?: readonly DnsResolver[]
  /** dns: what the resolvers were asked, to be said above what they answered: "the A record of example.com". */
  question?: string
}

interface Phase {
  label: string
  ms: number
  color: string
}

function phasesOf(details: ProbeDetails): Phase[] {
  const phases: Phase[] = []
  if (details.connectMs !== undefined) phases.push({ label: 'Connect', ms: details.connectMs, color: 'var(--chart-2)' })
  if (details.tlsMs !== undefined) phases.push({ label: 'TLS', ms: details.tlsMs, color: 'var(--chart-4)' })
  if (details.waitMs !== undefined) phases.push({ label: 'Server', ms: details.waitMs, color: 'var(--chart-1)' })
  return phases
}

/** Where one request's time went, as proportions of a single bar. */
function PhaseBar({ phases }: { phases: Phase[] }) {
  const total = phases.reduce((sum, phase) => sum + phase.ms, 0)
  if (total <= 0) return null

  return (
    <div className="min-w-0 flex-1 basis-56">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {phases.map(phase => (
          <span
            key={phase.label}
            style={{ width: `${(phase.ms / total) * 100}%`, backgroundColor: phase.color }}
          />
        ))}
      </div>
      <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {phases.map(phase => (
          <div key={phase.label} className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: phase.color }} aria-hidden="true" />
            <dt className="text-muted-foreground">{phase.label}</dt>
            <dd className="font-mono text-foreground">{phase.ms.toFixed(1)} ms</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function Certificate({ expiresAt, asOf }: { expiresAt: number; asOf: Date }) {
  // Counted from the probe that saw the certificate, not from the clock: the
  // figure is then the same one a certificate alert is judged on.
  const daysLeft = Math.floor((expiresAt - asOf.getTime()) / DAY_MS)
  const tone = daysLeft < 0 ? 'text-destructive' : daysLeft < 14 ? 'text-warning' : 'text-foreground'

  return (
    <div>
      <p className="text-xs text-muted-foreground">Certificate</p>
      <p className={cn('mt-0.5 text-sm font-medium', tone)}>
        {daysLeft < 0
          ? `Expired ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago`
          : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`}
      </p>
      <p className="font-mono text-xs text-muted-foreground">
        until {new Date(expiresAt).toLocaleDateString('en-US', inDisplayZone({ month: 'short', day: 'numeric', year: 'numeric' }))}
      </p>
    </div>
  )
}

/** One thing a game server said about itself. */
function Fact({ label, children, mono }: { label: string; children: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 break-words text-sm font-medium text-foreground', mono && 'font-mono')}>{children}</p>
    </div>
  )
}

/** What a game server said about itself in answer to the latest probe. */
function GameServer({ info }: { info: GameServerInfo }) {
  const players =
    info.players !== undefined
      ? info.maxPlayers !== undefined ? `${info.players} / ${info.maxPlayers}` : String(info.players)
      : undefined

  return (
    <>
      {info.name && <Fact label="Server">{info.name}</Fact>}
      {players && <Fact label="Players" mono>{players}</Fact>}
      {info.map && <Fact label="Map">{info.map}</Fact>}
      {info.game && <Fact label="Game">{info.game}</Fact>}
      {info.version && <Fact label="Version" mono>{info.version}</Fact>}
    </>
  )
}

const SECTION_LABEL = 'text-sm font-medium text-card-foreground'

/**
 * The same lookup as each resolver answered it: how long each took, and what
 * each said. This is the reason to ask more than one. A record changed an
 * hour ago, a resolver that is slow tonight, one that refuses a name the
 * others serve: all of them are a row here that does not look like the rest.
 */
function ResolverTable({
  readings,
  resolvers,
  question,
  asOf,
}: {
  readings: DnsResolverReading[]
  resolvers: readonly DnsResolver[]
  question?: string
  asOf: Date
}) {
  const differing = resolversThatDiffer(readings)
  // The bars share one scale, so the slowest resolver is the full width.
  const slowest = Math.max(1, ...readings.map(reading => reading.latency ?? 0))
  const sent = readings.find(reading => reading.sent)?.sent
  const encrypted = readings.some(reading => reading.connectMs !== undefined)
  const time = asOf.toLocaleTimeString('en-US', inDisplayZone({ hour: '2-digit', minute: '2-digit', second: '2-digit' }))

  return (
    <div className="min-w-0 basis-full">
      <p className={SECTION_LABEL}>
        Latest probe, resolver by resolver
        {differing.size > 0 && (
          <span className="ml-2"><Badge tone="warning" size="sm">They do not all agree</Badge></span>
        )}
      </p>
      {/* What the rows are rows of, before any of them is read. */}
      <p className="mt-1 text-xs text-muted-foreground">
        At {time} each resolver was sent {sent ? `${sent} queries` : 'the same queries'}
        {question && <> for {question}</>}, all at the same moment.
      </p>
      <div className="mt-3">
        <SortableDataTable
          caption="Resolver by resolver"
          itemName={{ one: 'resolver', other: 'resolvers' }}
          rowKey="label"
          rows={readings.map(reading => ({
            label: reading.label,
            name: readingName(reading, resolvers),
            // Unanswered sorts last, as the slowest of all.
            latency: reading.latency ?? Number.MAX_SAFE_INTEGER,
            answered: 100 - reading.loss,
            connect: reading.connectMs ?? -1,
            answer: reading.answers?.join(', ') ?? '',
            reading,
          }))}
          columns={[
            {
              key: 'name',
              label: 'Resolver',
              render: (_, { reading, name }) => (
                <span className="flex items-center gap-2">
                  {/* The dot says how it went, in the loss colours; the badge only which protocol. */}
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: reading.latency === null ? NO_REPLY_COLOR : getPacketLossVar(reading.loss) }}
                    aria-hidden="true"
                  />
                  {/* By the name it has now, and without the protocol: the badge says that. */}
                  <span className="whitespace-nowrap font-medium text-foreground">{name}</span>
                  <Tooltip content={DNS_PROTOCOL_NAME[reading.protocol]}>
                    <span tabIndex={0}>
                      <Badge size="sm" tone="neutral">
                        {DNS_PROTOCOL_LABEL[reading.protocol]}
                      </Badge>
                    </span>
                  </Tooltip>
                </span>
              ),
            },
            {
              key: 'latency',
              label: 'Query time',
              numeric: true,
              render: (_, { reading }) =>
                reading.latency === null ? (
                  <LossFigure loss={100} className="font-sans">no answer</LossFigure>
                ) : (
                  <span className="flex items-center justify-end gap-2">
                    <span className="hidden h-1.5 w-20 rounded-full bg-muted @2xl/main:block" aria-hidden="true">
                      <span className="block h-full min-w-1 rounded-full bg-trace/70" style={{ width: `${(reading.latency / slowest) * 100}%` }} />
                    </span>
                    <span className="font-mono">{reading.latency.toFixed(1)} ms</span>
                  </span>
                ),
            },
            {
              key: 'answered',
              label: 'Answered',
              numeric: true,
              render: (_, { reading }) => (
                // Out of how many, where that was kept; as a share where it was not.
                <LossFigure loss={reading.loss}>
                  {reading.sent
                    ? `${Math.round(reading.sent * (1 - reading.loss / 100))} of ${reading.sent}`
                    : `${(100 - reading.loss).toFixed(0)}%`}
                </LossFigure>
              ),
            },
            ...(encrypted
              ? [
                  {
                    key: 'connect',
                    label: 'Connect',
                    numeric: true,
                    render: (value: unknown) => (
                      <span className="font-mono text-muted-foreground">{(value as number) < 0 ? 'none' : `${(value as number).toFixed(0)} ms`}</span>
                    ),
                  },
                ]
              : []),
            {
              key: 'answer',
              label: 'Answer',
              sortable: false,
              render: (_, { reading }) => {
                const differs = differing.has(reading.label)
                return (
                  <span className="block min-w-48">
                    {reading.answers && reading.answers.length > 0 && (
                      <span className={cn('break-all font-mono', differs ? 'text-warning' : 'text-foreground')}>
                        {reading.answers.join(', ')}
                        {differs && <span className="ml-2"><Badge tone="warning" size="sm">Differs</Badge></span>}
                      </span>
                    )}
                    {reading.error && <span className="block break-all text-destructive">{reading.error}</span>}
                  </span>
                )
              },
            },
          ]}
        />
      </div>
      <dl className="mt-3 space-y-1 text-xs leading-relaxed text-muted-foreground">
        <div>
          <dt className="inline font-medium text-muted-foreground">Query time </dt>
          <dd className="inline">is the average of the queries that were answered, from sending one to its answer arriving.</dd>
        </div>
        <div>
          <dt className="inline font-medium text-muted-foreground">Answered </dt>
          <dd className="inline">
            is how many of those queries came back with an answer that could be used. One that timed out, came back as
            an error, or gave something other than the expected answer does not count. Nothing here is a lost packet:
            a DNS probe counts questions and answers.
          </dd>
        </div>
        {encrypted && (
          <div>
            <dt className="inline font-medium text-muted-foreground">Connect </dt>
            <dd className="inline">
              is how long the encrypted connection (DoT, DoH) took to open. It is opened once a probe and is not part
              of the query time; plain DNS has none.
            </dd>
          </div>
        )}
        {differing.size > 0 && (
          <div>
            <dt className="inline font-medium text-warning">Differs </dt>
            <dd className="inline">
              marks an answer that is not the one most of them gave. That is usual for a name served by region, and
              worth a look for a record that was changed lately.
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}

export function ProbeDetailsPanel({ probeType, latest, label, resolverList = [], question }: ProbeDetailsPanelProps) {
  if (!latest) return null

  const details = latest.details ?? {}
  const failure = !latest.success ? latest.errorMessage : undefined
  const phases = phasesOf(details)
  const resolvers = probeType === 'dns' ? details.resolvers ?? [] : []
  // With a row for each resolver saying what it answered, one answer picked
  // out above them would be a second copy of the first row.
  const answers = probeType === 'dns' && resolvers.length === 0 ? details.answers ?? [] : []
  const gameServer = probeType === 'game' ? details.gameServer : undefined

  const hasBody =
    details.statusCode !== undefined ||
    phases.length > 0 ||
    details.certExpiresAt !== undefined ||
    answers.length > 0 ||
    resolvers.length > 0 ||
    gameServer !== undefined

  if (!failure && !hasBody) return null

  return (
    <section className="rounded-3xl border border-border bg-card px-4 py-4 @2xl/main:px-6">
      {label && <p className="mb-3 text-sm font-medium text-card-foreground">{label}</p>}
      {failure && (
        <div className={cn(hasBody && 'mb-4')}>
          <Alert tone="danger" title="Last probe failed">{failure}</Alert>
        </div>
      )}

      {hasBody && (
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          {details.statusCode !== undefined && (
            <div>
              <p className="text-xs text-muted-foreground">Status</p>
              <p className="mt-0.5 font-mono text-sm font-medium text-foreground">HTTP {details.statusCode}</p>
            </div>
          )}

          {gameServer && <GameServer info={gameServer} />}

          {details.certExpiresAt !== undefined && (
            <Certificate expiresAt={details.certExpiresAt} asOf={latest.timestamp} />
          )}

          {answers.length > 0 && (
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Answer</p>
              <p className="mt-0.5 break-all font-mono text-xs text-foreground">{answers.join(', ')}</p>
            </div>
          )}

          <PhaseBar phases={phases} />

          {resolvers.length > 0 && (
            <ResolverTable readings={resolvers} resolvers={resolverList} question={question} asOf={latest.timestamp} />
          )}
        </div>
      )}
    </section>
  )
}
