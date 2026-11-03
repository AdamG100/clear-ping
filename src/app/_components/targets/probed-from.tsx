import type { CSSProperties } from 'react'
import { MapPin } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { inDisplayZone } from '@/lib/time-zone'
import { cn } from '@/lib/utils'
import type { ProbeAgentSummary } from '@/types/probe-agent'
import type { Target } from '@/types/probe'
import { probeIdsOf } from '@/lib/targets/probes'
import { PROBE_AGENT_STATE } from '../settings/probe-agent-labels'
import { useMask } from '../privacy/use-privacy'

/**
 * A colour no other badge has: grey and blue say what a target is, green,
 * amber and red how it is doing. Set through the badge's own variables, which
 * a class could not reach past Arc's module.
 */
const REMOTE_COLOURS = {
  '--badge-color': 'var(--series-2)',
  '--badge-foreground': 'color-mix(in oklab, var(--series-2) 55%, var(--foreground))',
  '--badge-background': 'color-mix(in oklab, var(--series-2) 12%, var(--surface))',
  '--badge-border': 'color-mix(in oklab, var(--series-2) 30%, var(--border))',
} as CSSProperties

/**
 * Where a target is probed from, wherever the target is shown: a "Remote"
 * badge beside its type, with the probe agent named in its tooltip. A target
 * probed from this server shows nothing, so the dashboard looks as it always
 * has for anyone without probe agents.
 *
 * While the agent cannot be reached the badge says so in the warning colour:
 * the target's readings have stopped because of the agent, not the target.
 */
export function ProbedFrom({ agent, count = 1, className }: { agent?: ProbeAgentSummary; count?: number; className?: string }) {
  const mask = useMask()
  // Measured from several probes: how many, not which, since there is no room for names.
  if (count > 1) {
    return (
      <Tooltip content={`Measured from ${count} probes. Open it to see each one.`}>
        <span className={cn('flex shrink-0', className)}>
          <span className="sr-only">Measured from {count} probes</span>
          <Badge size="sm" tone="neutral" icon={<MapPin size={10} strokeWidth={2} aria-hidden />} style={REMOTE_COLOURS} aria-hidden>
            {count} probes
          </Badge>
        </span>
      </Tooltip>
    )
  }
  if (!agent) return null
  const down = agent.state !== 'online' && agent.state !== 'unpaired'
  const machine = [agent.hostname, agent.address].filter((part): part is string => !!part).map(mask.address).join(', ')

  return (
    <Tooltip
      content={
        down
          ? `Probed from ${agent.name}, which is ${PROBE_AGENT_STATE[agent.state].label.toLowerCase()}: no readings are taken until it is back.`
          : `Probed from ${agent.name}${machine ? ` (${machine})` : ''}. Readings show the network as seen from there.`
      }
    >
      <span className={cn('flex shrink-0', className)}>
        {/* One short word, never the name: a name can be any length, and the
            row has no room to give it. The tooltip and screen readers have it. */}
        <span className="sr-only">Probed from {agent.name}{down ? ', offline' : ''}</span>
        <Badge
          size="sm"
          tone={down ? 'warning' : 'neutral'}
          icon={<MapPin size={10} strokeWidth={2} aria-hidden />}
          style={down ? undefined : REMOTE_COLOURS}
          aria-hidden
        >
          Remote
        </Badge>
      </span>
    </Tooltip>
  )
}

/**
 * Why a target probed from this agent is taking no readings, or undefined
 * while the agent is working. Shown on its status dot in place of its last
 * reading, which says nothing about now.
 */
export function holdReason(agent: ProbeAgentSummary): string | undefined {
  const why = agentDown(agent)
  return why ? `No readings: ${why}` : undefined
}

/** What is wrong with a probe agent, as the middle of a sentence; undefined while it works. */
export function agentDown(agent: ProbeAgentSummary): string | undefined {
  if (agent.state === 'online') return undefined
  if (agent.state === 'unpaired') return `probe agent ${agent.name} is not connected yet`
  const since = agent.lastSeenAt
    ? ` (last seen ${new Date(agent.lastSeenAt).toLocaleString(undefined, inDisplayZone({ dateStyle: 'short', timeStyle: 'short' }))})`
    : ''
  return `probe agent ${agent.name} is ${PROBE_AGENT_STATE[agent.state].label.toLowerCase()}${since}`
}

/** Which targets the sidebar lists: all of them, this server's, or one probe agent's by its id. */
export type ProbeFromFilter = 'all' | 'local' | (string & {})

export function matchesProbeFrom(target: Pick<Target, 'probes' | 'probeAgentId'>, filter: ProbeFromFilter): boolean {
  if (filter === 'all') return true
  return probeIdsOf(target).includes(filter)
}

/** The sentence for a target's page: where its readings are taken from, and whether that is working. */
export function probedFromLine(agent: ProbeAgentSummary | undefined): string {
  if (!agent) return 'Measured from the local probe'
  const state = PROBE_AGENT_STATE[agent.state].label
  return `Probed from ${agent.name}${agent.hostname ? ` · ${agent.hostname}` : ''} · ${state}`
}
