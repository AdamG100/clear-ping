import { MapPin } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { inDisplayZone } from '@/lib/time-zone'
import { cn } from '@/lib/utils'
import type { ProbeAgentSummary } from '@/types/probe-agent'
import type { Target } from '@/types/probe'
import { probeIdsOf } from '@/lib/targets/probes'
import { PROBE_AGENT_STATE } from '../settings/probe-agent-labels'

/**
 * How many probes measure a monitor, in the sidebar, when it is more than one:
 * a plain count, since its page has the names. A monitor on a single probe,
 * local or a probe agent, shows nothing; a probe agent that is down greys the
 * monitor's status dot and says why there.
 */
export function ProbeCount({ count, className }: { count: number; className?: string }) {
  if (count < 2) return null
  return (
    <Tooltip content={`Measured from ${count} probes. Open it to see each one.`}>
      <span className={cn('flex shrink-0', className)}>
        <span className="sr-only">Measured from {count} probes</span>
        {/* The icon and the number only: the row's name needs the room more. */}
        <Badge size="sm" tone="neutral" icon={<MapPin size={10} strokeWidth={2} aria-hidden />} aria-hidden>
          {count}
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
