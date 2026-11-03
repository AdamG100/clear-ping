import type { AlertMetric } from './probe';
import type { ProbeId } from './probe-agent';

/**
 * What an alert watches for, beyond one threshold: several conditions, how long
 * they must hold, how it clears, where it applies, and how many probes must
 * agree. An alert made before these existed is one condition, held for some
 * readings in a row, on every probe of the monitors ticked for it.
 */

/** One thing an alert watches: a metric past a threshold. */
export interface AlertCondition {
  metric: AlertMetric;
  /** The value that is a problem (ignored for `unreachable`). */
  threshold: number;
  /** Where the problem is over, when that is not the threshold itself: a rule that fires above 5% and clears below 2%. */
  clearThreshold?: number;
  /** Judge the mean of the newest this-many readings instead of the newest alone. */
  window?: number;
}

/** How several conditions add up: any one, all of them, or at least this many. */
export type AlertCombine = 'any' | 'all' | { atLeast: number };

/** How many of a monitor's probes must be in breach for it to be. */
export type ProbePolicy =
  | { kind: 'any' }
  | { kind: 'all' }
  | { kind: 'atLeast'; count: number }
  | { kind: 'share'; percent: number };

/** Somewhere an alert applies: a monitor, everything in a group, or what one probe measures. */
export type AlertScopeEntry = { kind: 'monitor' | 'group' | 'probe'; ref: string };

/** What an alert says beyond one metric and threshold. All optional: left out, the alert is as it was. */
export interface AlertRuleSettings {
  /** Its conditions, one to six. Absent is the one in `metric` and `threshold`. */
  conditions?: AlertCondition[];
  combine?: AlertCombine;
  /** Hold for this many minutes rather than `consecutiveProbes` readings. */
  forMinutes?: number;
  /** How long it must be clear to resolve, in the unit of the duration; the duration itself when absent. */
  clearAfter?: number;
  policy?: ProbePolicy;
  /** Only these probes count; every probe of each monitor when absent. */
  probes?: ProbeId[] | null;
  /** Everywhere it applies besides the monitors ticked. */
  scope?: AlertScopeEntry[];
}

/** One condition as it stood when an alert fired or cleared. */
export interface ConditionResult {
  label: string;
  /** The value, worded, or null when the probe had none. */
  observed: string | null;
  /** Whether it held at that moment. */
  held: boolean;
}

/** One probe as it stood when an alert fired or cleared. */
export interface ProbeVerdict {
  probe: ProbeId;
  name: string;
  breaching: boolean;
  /** Not reporting: no reading in two intervals, or its probe agent is down. */
  silent: boolean;
}

/** An entry in an alert's history: what changed, and why. */
export interface AlertHistoryEvent {
  id: number;
  at: number;
  alertId: string;
  targetId: string;
  targetName: string;
  transition: 'firing' | 'resolved';
  conditions: ConditionResult[];
  probes: ProbeVerdict[];
  /** The policy and what it came to: "at least 4 of 7 probes: 5 in breach". */
  reason: string;
}
