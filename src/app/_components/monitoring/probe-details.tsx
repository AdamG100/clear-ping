import { cn } from '@/lib/utils'
import { DNS_PROTOCOL_LABEL, DNS_PROTOCOL_NAME, readingName } from '@/lib/dns-resolvers'
import { resolversThatDiffer } from '@/lib/dns-resolver-series'
import type { DnsResolver, DnsResolverReading, LatestMeasurement, ProbeDetails, ProbeType } from '@/types/probe'

/**
 * What the latest probe learned beyond its timings.
 *
 * The three stat cards say how long and how often; this says what actually
 * came back — the status a web server answered with, where the time went
 * inside the request, how long its certificate has left, what a DNS query
 * resolved to — and, when the probe failed, why. A target that shows 100%
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
  const tone = daysLeft < 0 ? 'text-destructive' : daysLeft < 14 ? 'text-amber-500' : 'text-foreground'

  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">Certificate</p>
      <p className={cn('mt-0.5 text-sm font-medium', tone)}>
        {daysLeft < 0
          ? `Expired ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago`
          : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`}
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        until {new Date(expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      </p>
    </div>
  )
}

const SECTION_LABEL = 'text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70'

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
  const time = asOf.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  return (
    <div className="min-w-0 basis-full">
      <p className={SECTION_LABEL}>
        Latest probe, resolver by resolver
        {differing.size > 0 && (
          <span className="ml-2 normal-case tracking-normal text-signal-moderate">they do not all agree</span>
        )}
      </p>
      {/* What the rows are rows of, before any of them is read. */}
      <p className="mt-1 text-xs text-muted-foreground">
        At {time} each resolver was sent {sent ? `${sent} queries` : 'the same queries'}
        {question && <> for {question}</>}, all at the same moment.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground/70">
              <th className="pb-1.5 pr-4 font-medium">Resolver</th>
              <th className="whitespace-nowrap pb-1.5 pr-4 text-right font-medium">Query time</th>
              <th className="hidden w-[18%] pb-1.5 pr-4 @2xl/main:table-cell" />
              <th className="pb-1.5 pr-4 text-right font-medium">Answered</th>
              <th className="hidden pb-1.5 pr-4 text-right font-medium @lg/main:table-cell">Connect</th>
              <th className="pb-1.5 font-medium">Answer</th>
            </tr>
          </thead>
          <tbody>
            {readings.map(reading => {
              const failed = reading.latency === null
              const differs = differing.has(reading.label)
              // Out of how many, where that was kept; as a share where it was not.
              const answered = reading.sent
                ? `${Math.round(reading.sent * (1 - reading.loss / 100))} of ${reading.sent}`
                : `${(100 - reading.loss).toFixed(0)}%`

              return (
                <tr key={reading.label} className={cn('border-t border-border/50 align-top', failed && 'bg-destructive/5')}>
                  <td className="py-1.5 pr-4">
                    <span className="flex items-center gap-2">
                      <span
                        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', failed ? 'bg-destructive' : reading.loss > 0 ? 'bg-signal-moderate' : 'bg-signal-perfect')}
                        aria-hidden="true"
                      />
                      {/* By the name it has now, and without the protocol: the badge says that. */}
                      <span className="whitespace-nowrap font-medium text-foreground">{readingName(reading, resolvers)}</span>
                      <span
                        className="rounded border border-border px-1 py-px text-[10px] leading-none text-muted-foreground"
                        title={DNS_PROTOCOL_NAME[reading.protocol]}
                      >
                        {DNS_PROTOCOL_LABEL[reading.protocol]}
                      </span>
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-4 text-right font-mono text-foreground">
                    {reading.latency === null ? <span className="text-destructive">no answer</span> : `${reading.latency.toFixed(1)} ms`}
                  </td>
                  <td className="hidden py-1.5 pr-4 align-middle @2xl/main:table-cell">
                    {reading.latency !== null && (
                      <span className="block h-1.5 rounded-full bg-muted/40" aria-hidden="true">
                        <span
                          className="block h-full min-w-1 rounded-full bg-trace/70"
                          style={{ width: `${(reading.latency / slowest) * 100}%` }}
                        />
                      </span>
                    )}
                  </td>
                  <td className={cn('whitespace-nowrap py-1.5 pr-4 text-right font-mono', reading.loss > 0 ? 'text-destructive' : 'text-muted-foreground')}>
                    {answered}
                  </td>
                  <td className="hidden whitespace-nowrap py-1.5 pr-4 text-right font-mono text-muted-foreground @lg/main:table-cell">
                    {reading.connectMs === undefined ? '—' : `${reading.connectMs.toFixed(0)} ms`}
                  </td>
                  {/* Wide enough to be read: on a phone the table is scrolled
                      sideways to it, instead of the answer being broken into
                      a column three characters across. */}
                  <td className="min-w-48 py-1.5">
                    {reading.answers && reading.answers.length > 0 && (
                      <span className={cn('break-all font-mono', differs ? 'text-signal-moderate' : 'text-foreground')}>
                        {reading.answers.join(', ')}
                        {differs && <span className="ml-2 font-sans text-[10px] font-medium">differs</span>}
                      </span>
                    )}
                    {reading.error && (
                      <span className="block break-all text-destructive">{reading.error}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <dl className="mt-3 space-y-1 text-[11px] leading-relaxed text-muted-foreground/80">
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
            <dt className="inline font-medium text-signal-moderate">Differs </dt>
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

  const hasBody =
    details.statusCode !== undefined ||
    phases.length > 0 ||
    details.certExpiresAt !== undefined ||
    answers.length > 0 ||
    resolvers.length > 0

  if (!failure && !hasBody) return null

  return (
    <section className="rounded-xl border border-border bg-card px-4 py-4 @2xl/main:px-5">
      {label && (
        <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{label}</p>
      )}
      {failure && (
        <p className={cn('flex flex-wrap items-baseline gap-x-2 text-sm', hasBody && 'mb-3')}>
          <span className="font-medium text-destructive">Last probe failed</span>
          <span className="break-all font-mono text-xs text-muted-foreground">{failure}</span>
        </p>
      )}

      {hasBody && (
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          {details.statusCode !== undefined && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">Status</p>
              <p className="mt-0.5 font-mono text-sm font-medium text-foreground">HTTP {details.statusCode}</p>
            </div>
          )}

          {details.certExpiresAt !== undefined && (
            <Certificate expiresAt={details.certExpiresAt} asOf={latest.timestamp} />
          )}

          {answers.length > 0 && (
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">Answer</p>
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
