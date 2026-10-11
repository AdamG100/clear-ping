import { cn } from '@/lib/utils'
import type { LatestMeasurement, ProbeDetails, ProbeType } from '@/types/probe'

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

export function ProbeDetailsPanel({ probeType, latest, label }: ProbeDetailsPanelProps) {
  if (!latest) return null

  const details = latest.details ?? {}
  const failure = !latest.success ? latest.errorMessage : undefined
  const phases = phasesOf(details)
  const answers = probeType === 'dns' ? details.answers ?? [] : []

  const hasBody =
    details.statusCode !== undefined || phases.length > 0 || details.certExpiresAt !== undefined || answers.length > 0

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
        </div>
      )}
    </section>
  )
}
