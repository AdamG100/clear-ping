'use client'

import { Plus, X } from 'lucide-react'
import { Accordion } from '@/components/arc/accordion/accordion'
import { Button } from '@/components/arc/button/button'
import { Checkbox } from '@/components/arc/checkbox/checkbox'
import { NumberField } from '@/components/arc/number-field/number-field'
import { Select } from '@/components/arc/select/select'
import { SegmentedField } from '@/components/segmented-field'
import { groupLabel } from '@/lib/targets/group-path'
import { describePolicy } from '@/lib/alerts/rules'
import type { AlertCondition, AlertCombine, AlertScopeEntry, ProbePolicy } from '@/types/alert-rules'
import { ALERT_METRIC_LABELS, type AlertMetric } from '@/types/probe'
import type { ProbeId, ProbeSummary } from '@/types/probe-agent'
import { ProbeChecklist } from '../targets/probe-checklist'

/** What "More options" holds, as the form keeps it. */
export interface RuleOptions {
  /** Conditions besides the first (which is the form's own metric and threshold). */
  extra: AlertCondition[]
  combine: 'any' | 'all' | 'atLeast'
  combineCount: number
  /** Held for minutes rather than readings in a row. */
  byMinutes: boolean
  minutes: number
  /** Clear after this long (readings or minutes, as the duration is); the same as the duration when 0. */
  clearAfter: number
  /** The first condition's own clear threshold, and window. */
  clearThreshold: number | null
  window: number
  policy: ProbePolicy['kind']
  policyCount: number
  policyPercent: number
  /** The probes that count; null for every probe. */
  probes: ProbeId[] | null
  groups: string[]
  probeScope: ProbeId[]
  /** Also tell the alert's notification URLs when a probe agent goes offline or is back. */
  probeAgentOffline: boolean
}

export const NO_OPTIONS: RuleOptions = {
  extra: [], combine: 'any', combineCount: 2, byMinutes: false, minutes: 5, clearAfter: 0, clearThreshold: null, window: 1,
  policy: 'any', policyCount: 2, policyPercent: 60, probes: null, groups: [], probeScope: [], probeAgentOffline: false,
}

/** The options an existing alert has, as the form keeps them. */
export function optionsOf(alert: {
  conditions?: AlertCondition[]; combine?: AlertCombine; forMinutes?: number; clearAfter?: number; policy?: ProbePolicy; probes?: ProbeId[] | null; scope?: AlertScopeEntry[]; probeAgentOffline?: boolean
}): RuleOptions {
  const [first, ...extra] = alert.conditions ?? []
  const combine = alert.combine
  const policy = alert.policy ?? { kind: 'any' }
  return {
    extra,
    combine: combine === undefined || combine === 'any' ? 'any' : combine === 'all' ? 'all' : 'atLeast',
    combineCount: typeof combine === 'object' ? combine.atLeast : 2,
    byMinutes: !!alert.forMinutes,
    minutes: alert.forMinutes || 5,
    clearAfter: alert.clearAfter ?? 0,
    clearThreshold: first?.clearThreshold ?? null,
    window: first?.window ?? 1,
    policy: policy.kind,
    policyCount: policy.kind === 'atLeast' ? policy.count : 2,
    policyPercent: policy.kind === 'share' ? policy.percent : 60,
    probes: alert.probes ?? null,
    groups: (alert.scope ?? []).filter(entry => entry.kind === 'group').map(entry => entry.ref),
    probeScope: (alert.scope ?? []).filter(entry => entry.kind === 'probe').map(entry => entry.ref),
    probeAgentOffline: alert.probeAgentOffline === true,
  }
}

/** Whether the options say anything the simple form does not. */
export function isCustom(options: RuleOptions): boolean {
  return JSON.stringify({ ...options, minutes: options.byMinutes ? options.minutes : 0 }) !== JSON.stringify({ ...NO_OPTIONS, minutes: 0 })
}

/** What the options add to an alert's payload. */
export function ruleFields(
  options: RuleOptions,
  first: { metric: AlertMetric; threshold: number }
): {
  conditions?: AlertCondition[]; combine?: AlertCombine; forMinutes: number | null; clearAfter: number | null; policy: ProbePolicy; probes: ProbeId[] | null; scope: AlertScopeEntry[]; probeAgentOffline: boolean
} {
  const head: AlertCondition = { ...first, ...(options.clearThreshold !== null ? { clearThreshold: options.clearThreshold } : {}), ...(options.window > 1 ? { window: options.window } : {}) }
  const conditions = [head, ...options.extra]
  const needsConditions = conditions.length > 1 || head.clearThreshold !== undefined || head.window !== undefined
  return {
    ...(needsConditions ? { conditions } : {}),
    combine: options.combine === 'atLeast' ? { atLeast: options.combineCount } : options.combine,
    forMinutes: options.byMinutes ? options.minutes : null,
    clearAfter: options.clearAfter > 0 ? options.clearAfter : null,
    policy:
      options.policy === 'atLeast' ? { kind: 'atLeast', count: options.policyCount }
      : options.policy === 'share' ? { kind: 'share', percent: options.policyPercent }
      : { kind: options.policy },
    probes: options.probes,
    probeAgentOffline: options.probeAgentOffline,
    scope: [
      ...options.groups.map(ref => ({ kind: 'group' as const, ref })),
      ...options.probeScope.map(ref => ({ kind: 'probe' as const, ref })),
    ],
  }
}

function toggle<T>(list: T[], item: T, on: boolean): T[] {
  return on ? [...list.filter(each => each !== item), item] : list.filter(each => each !== item)
}

/**
 * Everything an alert can say beyond one condition on the monitors ticked: more
 * conditions and how they add up, how long they must hold and how it clears,
 * where else it applies, and how many probes must agree. Folded away, so the
 * simple form stays simple.
 */
export function RuleOptionsPanel({
  options,
  onChange,
  groups,
  probes,
  firstMetric,
}: {
  options: RuleOptions
  onChange: (options: RuleOptions) => void
  groups: string[]
  probes: ProbeSummary[]
  firstMetric: AlertMetric
}) {
  const set = (changes: Partial<RuleOptions>) => onChange({ ...options, ...changes })
  const several = probes.length > 1
  const unit = options.byMinutes ? ' minutes' : ' readings'
  const metrics = Object.keys(ALERT_METRIC_LABELS) as AlertMetric[]
  const clearable = firstMetric !== 'unreachable' && firstMetric !== 'certExpiry'

  const conditionsPanel = (
    <div className="space-y-4 text-foreground">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Add conditions to fire on a mix: loss above 5% and latency above 200 ms, say. Each probe is judged on its own readings.
      </p>
      {options.extra.map((condition, index) => (
        <div key={index} className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1">
            <Select
              label={`Condition ${index + 2}`}
              value={condition.metric}
              onValueChange={value => set({ extra: options.extra.map((each, at) => (at === index ? { metric: value as AlertMetric, threshold: Number(DEFAULTS[value as AlertMetric]) } : each)) })}
              options={metrics.map(metric => ({ value: metric, label: ALERT_METRIC_LABELS[metric].label }))}
            />
          </div>
          {condition.metric !== 'unreachable' && (
            <div className="w-36">
              <NumberField
                label={ALERT_METRIC_LABELS[condition.metric].comparison === 'below' ? 'Under' : 'Above'}
                suffix={ALERT_METRIC_LABELS[condition.metric].unit}
                min={0}
                max={100000}
                value={condition.threshold}
                onValueChange={value => set({ extra: options.extra.map((each, at) => (at === index ? { ...each, threshold: value } : each)) })}
              />
            </div>
          )}
          <Button type="button" variant="ghost" size="sm" aria-label={`Remove condition ${index + 2}`} onClick={() => set({ extra: options.extra.filter((_, at) => at !== index) })}>
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </div>
      ))}
      {options.extra.length < 5 && (
        <Button type="button" variant="secondary" size="sm" onClick={() => set({ extra: [...options.extra, { metric: 'latency', threshold: 200 }] })}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          Add a condition
        </Button>
      )}
      {options.extra.length > 0 && (
        <>
          <SegmentedField
            label="Fire when"
            value={options.combine}
            onValueChange={value => set({ combine: value as RuleOptions['combine'] })}
            options={[{ value: 'any', label: 'Any holds' }, { value: 'all', label: 'All hold' }, { value: 'atLeast', label: 'At least…' }]}
          />
          {options.combine === 'atLeast' && (
            <NumberField label="At least this many conditions" min={1} max={options.extra.length + 1} value={options.combineCount} onValueChange={value => set({ combineCount: value })} />
          )}
        </>
      )}
      {clearable && (
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <NumberField
            label="First condition clears under"
            suffix={ALERT_METRIC_LABELS[firstMetric].unit}
            min={0}
            max={100000}
            value={options.clearThreshold ?? 0}
            onValueChange={value => set({ clearThreshold: value > 0 ? value : null })}
          />
          <NumberField label="Judge the mean of the newest" suffix=" readings" min={1} max={100} value={options.window} onValueChange={value => set({ window: value })} />
        </div>
      )}
    </div>
  )

  const durationPanel = (
    <div className="space-y-4 text-foreground">
      <SegmentedField
        label="Hold for"
        value={options.byMinutes ? 'minutes' : 'readings'}
        onValueChange={value => set({ byMinutes: value === 'minutes' })}
        options={[{ value: 'readings', label: 'Readings in a row' }, { value: 'minutes', label: 'Minutes' }]}
      />
      {options.byMinutes && <NumberField label="Fire after it has held for" suffix=" minutes" min={1} max={10080} value={options.minutes} onValueChange={value => set({ minutes: value })} />}
      <NumberField
        label="Clear after"
        suffix={unit}
        min={0}
        max={10080}
        value={options.clearAfter}
        onValueChange={value => set({ clearAfter: value })}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        Clear after 0 is the same as the time it takes to fire. A probe that goes quiet for longer than two intervals starts a duration in minutes again.
      </p>
    </div>
  )

  const scopePanel = (
    <div className="space-y-4 text-foreground">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Besides the monitors ticked, the alert covers all of these, including any added to them later.
      </p>
      {groups.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Groups</legend>
          {groups.map(group => (
            <Checkbox key={group} label={groupLabel(group)} checked={options.groups.includes(group)} onCheckedChange={on => set({ groups: toggle(options.groups, group, on === true) })} />
          ))}
        </fieldset>
      )}
      {several && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Everything one probe measures</legend>
          {probes.map(probe => (
            <Checkbox key={probe.id} label={probe.name} checked={options.probeScope.includes(probe.id)} onCheckedChange={on => set({ probeScope: toggle(options.probeScope, probe.id, on === true) })} />
          ))}
        </fieldset>
      )}
      {several && (
        <Checkbox
          label="Also tell these URLs when a probe agent goes offline"
          description="And when it is back. How long a probe agent may be silent is set under Settings, Probes."
          checked={options.probeAgentOffline}
          onCheckedChange={on => set({ probeAgentOffline: on === true })}
        />
      )}
      {groups.length === 0 && !several && (
        <p className="text-xs text-muted-foreground">There are no groups or probe agents to add yet.</p>
      )}
    </div>
  )

  const probesPanel = (
    <div className="space-y-4 text-foreground">
      <Select
        label="Fire when"
        value={options.policy}
        onValueChange={value => set({ policy: value as RuleOptions['policy'] })}
        options={[
          { value: 'any', label: 'Any one probe sees it' },
          { value: 'all', label: 'Every probe sees it' },
          { value: 'atLeast', label: 'At least some number of probes' },
          { value: 'share', label: 'At least a share of the probes' },
        ]}
      />
      {options.policy === 'atLeast' && <NumberField label="At least this many probes" min={1} max={1000} value={options.policyCount} onValueChange={value => set({ policyCount: value })} />}
      {options.policy === 'share' && <NumberField label="At least this share of them" suffix="%" min={1} max={100} value={options.policyPercent} onValueChange={value => set({ policyPercent: value })} />}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {describePolicy(options.policy === 'atLeast' ? { kind: 'atLeast', count: options.policyCount } : options.policy === 'share' ? { kind: 'share', percent: options.policyPercent } : { kind: options.policy }, probes.length)}
        {' '}must see it. A probe whose probe agent is offline is not counted as seeing it, and it clears only when too few could.
      </p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Count these probes</legend>
        <ProbeChecklist idPrefix="alert-probes" probes={probes} value={options.probes ?? probes.map(probe => probe.id)} onChange={next => set({ probes: next.length === probes.length ? null : next })} />
      </fieldset>
    </div>
  )

  return (
    <Accordion
      defaultOpen={-1}
      items={[
        { title: 'More conditions', content: conditionsPanel },
        { title: 'How long, and how it clears', content: durationPanel },
        { title: 'Where it applies', content: scopePanel },
        ...(several ? [{ title: 'How many probes must agree', content: probesPanel }] : []),
      ]}
    />
  )
}

const DEFAULTS: Record<AlertMetric, string> = { packetLoss: '5', latency: '200', jitter: '50', unreachable: '0', certExpiry: '14' }
