'use client'

import { useMemo } from 'react'
import { Checkbox } from '@/components/arc/checkbox/checkbox'
import { resolverLabel, sameResolver } from '@/lib/probes/dns/resolvers'
import { probeIdsOf } from '@/lib/targets/probes'
import type { ResolverProbeChange } from '@/lib/targets/resolver-probes'
import type { DnsResolver, Target } from '@/types/probe'
import type { ProbeSummary } from '@/types/probe-agent'

/**
 * Which probes ask which DNS resolvers, for every monitor in a group: a row for
 * each resolver its monitors ask, with a tick for each probe that measures
 * them. For a resolver that only answers inside its own network, such as a
 * provider's for its own customers, which would otherwise fail from anywhere
 * else. Part-ticked is one some of the monitors ask from that probe and some
 * do not; it stays that way until it is clicked.
 */
export function GroupResolvers({
  targets,
  probes,
  changes,
  onChange,
}: {
  /** The monitors in the group, groups inside it included. */
  targets: Target[]
  probes: ProbeSummary[]
  changes: ResolverProbeChange[]
  onChange: (changes: ResolverProbeChange[]) => void
}) {
  const asking = useMemo(() => targets.filter(target => (target.probeConfig?.resolvers?.length ?? 0) > 0), [targets])

  const resolvers = useMemo(() => {
    const found: DnsResolver[] = []
    for (const target of asking) {
      for (const resolver of target.probeConfig?.resolvers ?? []) {
        if (!found.some(each => sameResolver(each, resolver))) found.push(resolver)
      }
    }
    return found
  }, [asking])

  const usedProbes = useMemo(() => {
    const used = new Set(asking.flatMap(target => probeIdsOf(target)))
    return probes.filter(probe => used.has(probe.id))
  }, [asking, probes])

  if (resolvers.length === 0 || usedProbes.length < 2) return null

  /** Ticked, unticked or part-ticked: as changed in this dialog, or as the monitors have it. */
  const stateOf = (resolver: DnsResolver, probe: string): boolean | 'indeterminate' => {
    const changed = changes.find(change => change.probe === probe && sameResolver(change, resolver))
    if (changed) return changed.asked
    const answers = asking.flatMap(target => {
      if (!probeIdsOf(target).includes(probe)) return []
      const own = target.probeConfig?.resolvers?.find(each => sameResolver(each, resolver))
      return own ? [!own.notFrom?.includes(probe)] : []
    })
    if (answers.every(Boolean)) return true
    return answers.some(Boolean) ? 'indeterminate' : false
  }

  const toggle = (resolver: DnsResolver, probe: string, asked: boolean) => {
    const rest = changes.filter(change => !(change.probe === probe && sameResolver(change, resolver)))
    onChange([...rest, { protocol: resolver.protocol, ...(resolver.server ? { server: resolver.server } : {}), probe, asked }])
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">Resolvers</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Which probes ask each resolver, for every DNS monitor in this group. Untick a probe for a resolver that only answers
        inside its own network, such as a provider&apos;s for its own customers, so it isn&apos;t shown as failing from there.
        Every probe needs at least one resolver left to ask.
      </p>
      <ul className="space-y-2">
        {resolvers.map(resolver => {
          const label = resolverLabel(resolver)
          return (
            <li key={`${resolver.protocol}|${resolver.server ?? ''}`} className="space-y-2 rounded-2xl border border-border bg-background px-3 py-2.5">
              <p className="truncate text-sm text-foreground">{label}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {usedProbes.map(probe => (
                  <Checkbox
                    key={probe.id}
                    id={`group-resolver-${label}-${probe.id}`}
                    label={probe.name}
                    checked={stateOf(resolver, probe.id)}
                    onCheckedChange={next => toggle(resolver, probe.id, next === true)}
                  />
                ))}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
