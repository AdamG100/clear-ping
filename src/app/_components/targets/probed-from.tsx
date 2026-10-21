import { MapPin } from 'lucide-react'
import { Badge } from '@/components/arc/badge/badge'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { inDisplayZone } from '@/lib/time-zone'
import type { ProbeAgentSummary } from '@/types/probe-agent'
import { PROBE_AGENT_STATE } from '../settings/probe-agent-labels'

/**
 * Where a target is probed from, wherever the target is shown: a pin and the
 * probe agent's name. A target probed from this server shows nothing, so the
 * dashboard looks as it always has for anyone without probe agents.
 *
 * While the agent cannot be reached the badge says so in the warning colour:
 * the target's readings have stopped because of the agent, not the target.
 */
export function ProbedFrom({ agent, className }: { agent?: ProbeAgentSummary; className?: string }) {
  if (!agent) return null
  const down = agent.state !== 'online' && agent.state !== 'unpaired'
  const machine = [agent.hostname, agent.address].filter(Boolean).join(', ')

  return (
    <Tooltip
      content={
        down
          ? `Probed from ${agent.name}, which is ${PROBE_AGENT_STATE[agent.state].label.toLowerCase()}: no readings are taken until it is back.`
          : `Probed from ${agent.name}${machine ? ` (${machine})` : ''}. Readings show the network as seen from there.`
      }
    >
      <span className={className}>
        <span className="sr-only">Probed from </span>
        <Badge size="sm" tone={down ? 'warning' : 'neutral'} icon={<MapPin size={10} strokeWidth={2} aria-hidden />}>
          {down ? `${agent.name} · offline` : agent.name}
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

export function matchesProbeFrom(target: { probeAgentId?: string | null }, filter: ProbeFromFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'local') return !target.probeAgentId
  return target.probeAgentId === filter
}

/** The sentence for a target's page: where its readings are taken from, and whether that is working. */
export function probedFromLine(agent: ProbeAgentSummary | undefined): string {
  if (!agent) return 'Probed from this server'
  const state = PROBE_AGENT_STATE[agent.state].label
  return `Probed from ${agent.name}${agent.hostname ? ` · ${agent.hostname}` : ''} · ${state}`
}
