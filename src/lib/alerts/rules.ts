import type { AlertCombine, AlertCondition, ProbePolicy, ProbeSpread } from '@/types/alert-rules';
import { ALERT_METRIC_LABELS, type AlertMetric, type AlertRule, type AlertSettings, type ProbeResult } from '@/types/probe';

/** The conditions of an alert: those it has, or the one in its metric and threshold. */
export function conditionsOf(alert: Pick<AlertSettings, 'metric' | 'threshold' | 'conditions'>): AlertCondition[] {
  return alert.conditions && alert.conditions.length > 0 ? alert.conditions : [{ metric: alert.metric, threshold: alert.threshold }];
}

/** The policy of an alert: any probe unless it says otherwise. */
export function policyOf(alert: Pick<AlertSettings, 'policy'>): ProbePolicy {
  return alert.policy ?? { kind: 'any' };
}

/**
 * Judging readings against an alert's rules, as pure functions.
 *
 * Two steps. Each probe's readings are judged on their own: every condition
 * holds or does not, the conditions add up (any, all, at least N), and the
 * result must keep to its duration before a probe is in breach (or out of it).
 * Then the monitor's probes are put to the policy: how many must be in breach.
 * Kept apart from the database so that every case can be tested as a table.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The value a rule watches, or null when the probe produced no reading for it. */
export function observedValue(rule: { metric: AlertMetric }, result: ProbeResult): number | null {
  switch (rule.metric) {
    case 'packetLoss':
      return result.packetLoss ?? null;
    case 'latency':
      return result.latency;
    case 'jitter':
      return result.jitter ?? null;
    case 'unreachable':
      return result.success ? 0 : 1;
    case 'certExpiry': {
      // Days of validity left, as of the probe that saw the certificate. Null
      // for anything that is not HTTPS, and for a probe that never got as far
      // as a handshake.
      const expiresAt = result.details?.certExpiresAt;
      if (expiresAt === undefined) return null;
      return Math.round(((expiresAt - result.timestamp.getTime()) / DAY_MS) * 10) / 10;
    }
  }
}

/** Whether this probe breaches the rule. */
export function isBreaching(rule: { metric: AlertMetric; threshold: number; state: AlertRule['state'] }, result: ProbeResult): boolean {
  const value = observedValue(rule, result);
  if (rule.metric === 'unreachable') return value === 1;

  // A probe with no reading for this metric is not evidence either way, so it
  // holds the current state rather than advancing a streak. Treating "unknown"
  // as "fine" would silently resolve a real alert, and treating it as a breach
  // would fire a latency rule on a host that is simply down.
  if (value === null) return rule.state === 'firing';

  return pastThreshold(rule.metric, value, rule.threshold);
}

function pastThreshold(metric: AlertMetric, value: number, threshold: number): boolean {
  return ALERT_METRIC_LABELS[metric].comparison === 'below' ? value < threshold : value > threshold;
}

/**
 * Advance a rule's state machine by one reading, counting readings.
 *
 * A rule fires only after `consecutiveProbes` breaching readings in a row, and
 * resolves only after the same number of clean ones: that is what stops a
 * single blip paging somebody at 3am.
 */
export function nextRuleState(
  rule: { state: AlertRule['state']; streak: number; consecutiveProbes: number },
  breaching: boolean
): { streak: number; state: AlertRule['state']; transition: 'firing' | 'resolved' | null } {
  // A reading advances the streak when it argues for changing the current state.
  const advancing = breaching === (rule.state === 'ok');
  const streak = advancing ? rule.streak + 1 : 0;

  if (advancing && streak >= rule.consecutiveProbes) {
    return {
      streak: 0,
      state: rule.state === 'ok' ? 'firing' : 'ok',
      transition: rule.state === 'ok' ? 'firing' : 'resolved',
    };
  }

  return { streak, state: rule.state, transition: null };
}

// ─── One probe ──────────────────────────────────────────────────────────────

/** What is remembered about one probe's readings against one alert. */
export interface ProbeRuleState {
  /** In breach: the alert holds from this probe. */
  inBreach: boolean;
  /** Readings (or, with a duration in minutes, readings at the start) in a row that argue for changing. */
  streak: number;
  /** When the current run of readings that argue for changing began, for a duration in minutes. */
  since: number | null;
  /** When the newest reading was judged, to tell a gap from a steady run. */
  at: number | null;
  /** Each condition as last judged, for the one that has no reading now to hold. */
  held: boolean[];
  /** The newest readings of each condition, for a window. */
  recent: number[][];
}

export const FRESH_PROBE_STATE: ProbeRuleState = { inBreach: false, streak: 0, since: null, at: null, held: [], recent: [] };

export interface ProbeRules {
  conditions: AlertCondition[];
  combine: AlertCombine;
  /** Readings the combined result must hold for. */
  readings: number;
  /** Or minutes, which then stands in for readings. */
  minutes?: number;
  /** How long it must be clear, in the unit of the duration; the duration when absent. */
  clearAfter?: number;
}

export interface ConditionOutcome {
  condition: AlertCondition;
  observed: number | null;
  held: boolean;
}

/** Whether `held` of the conditions add up under `combine`. */
export function combined(combine: AlertCombine, held: boolean[]): boolean {
  if (held.length === 0) return false;
  const count = held.filter(Boolean).length;
  if (combine === 'any') return count >= 1;
  if (combine === 'all') return count === held.length;
  return count >= combine.atLeast;
}

/**
 * Judge one reading from one probe. Each condition is latched on its own: on at
 * its threshold, off at its clear threshold, which falls back on the threshold
 * itself. One with no value in this reading keeps what it was. The conditions
 * are combined, and the result is held to the duration before the probe goes
 * in or out of breach. A duration in minutes starts counting at the first
 * reading that argues for a change and starts again after a gap of more than
 * two intervals, so a probe that was away does not fire the moment it returns.
 */
export function stepProbe(
  rules: ProbeRules,
  previous: ProbeRuleState,
  result: ProbeResult,
  now: number,
  intervalMs: number
): { state: ProbeRuleState; transition: 'firing' | 'resolved' | null; outcomes: ConditionOutcome[]; candidate: boolean } {
  const recent = rules.conditions.map((_, index) => previous.recent[index] ?? []);
  const outcomes: ConditionOutcome[] = rules.conditions.map((condition, index) => {
    const value = observedValue(condition, result);
    const held = previous.held[index] ?? false;
    // No value is no evidence either way: it holds the probe's current state, as an alert always
    // has, neither advancing a run towards firing nor towards clearing.
    if (value === null) return { condition, observed: null, held: previous.inBreach };

    // A window judges the mean of the newest readings; the newest alone otherwise.
    const size = Math.max(1, condition.window ?? 1);
    recent[index] = [...recent[index], value].slice(-size);
    const judged = recent[index].reduce((sum, each) => sum + each, 0) / recent[index].length;
    const rounded = condition.metric === 'certExpiry' ? judged : Math.round(judged * 100) / 100;

    if (condition.metric === 'unreachable') return { condition, observed: value, held: value === 1 };
    const over = pastThreshold(condition.metric, rounded, condition.threshold);
    // Held until it is back past the clear threshold, when there is one; without one it
    // holds only while it is over the threshold itself.
    const stillHeld = held && condition.clearThreshold !== undefined && pastThreshold(condition.metric, rounded, condition.clearThreshold);
    return { condition, observed: rounded, held: over || stillHeld };
  });

  const candidate = combined(rules.combine, outcomes.map(outcome => outcome.held));
  const wasIn = previous.inBreach;
  const arguing = candidate === !wasIn;

  // Going out of breach is held for the clear duration, which is the duration when none is given.
  const duration = rules.minutes ?? rules.readings;
  const needed = wasIn ? rules.clearAfter ?? duration : duration;

  // A run in minutes is not carried across a gap (a probe that went quiet
  // and came back), or it would fire at once on the first reading back.
  const gap = previous.at !== null && now - previous.at > intervalMs * 2;
  const fresh = previous.streak === 0 || (rules.minutes !== undefined && gap);
  const streak = !arguing ? 0 : fresh ? 1 : previous.streak + 1;
  const since = !arguing ? null : fresh ? now : previous.since ?? now;

  const done = arguing && (rules.minutes !== undefined ? now - (since ?? now) >= needed * 60_000 : streak >= needed);
  const next: ProbeRuleState = {
    inBreach: done ? !wasIn : wasIn,
    streak: done ? 0 : streak,
    since: done ? null : since,
    at: now,
    held: outcomes.map(outcome => outcome.held),
    recent,
  };
  return { state: next, transition: done ? (wasIn ? 'resolved' : 'firing') : null, outcomes, candidate };
}

// ─── The monitor's probes ───────────────────────────────────────────────────

/** Whether `breaching` of `total` probes meet a policy. */
export function policyHolds(policy: ProbePolicy, breaching: number, total: number): boolean {
  if (total <= 0) return false;
  switch (policy.kind) {
    case 'any':
      return breaching >= 1;
    case 'all':
      return breaching === total;
    case 'atLeast':
      return breaching >= policy.count;
    case 'share':
      return breaching >= Math.ceil((policy.percent / 100) * total);
  }
}

export interface ProbeStanding {
  probe: string;
  inBreach: boolean;
  /** Not reporting: no reading within two intervals, or its probe agent is down. */
  silent: boolean;
  /** Where it is, as labelled under Settings, Probes. */
  region?: string;
  network?: string;
}

/** Whether the probes in breach are spread over as many regions and networks as asked. */
export function spreadHolds(spread: ProbeSpread | null | undefined, breaching: Pick<ProbeStanding, 'region' | 'network'>[]): boolean {
  if (!spread) return true;
  const distinct = (pick: (each: Pick<ProbeStanding, 'region' | 'network'>) => string | undefined) =>
    new Set(breaching.map(pick).filter((label): label is string => !!label)).size;
  return distinct(each => each.region) >= (spread.regions ?? 0) && distinct(each => each.network) >= (spread.networks ?? 0);
}

/**
 * What the monitor does, given each of its probes: fire, resolve, or keep as it
 * is. Fires when the policy holds counting only the probes in breach, silent
 * ones as not; resolves only when it fails even with every silent probe counted
 * in breach. The two can then never hold together, so a quorum never fires and
 * clears in turn, and a probe agent going quiet never announces a recovery.
 */
export function judgeMonitor(
  policy: ProbePolicy,
  state: 'ok' | 'firing',
  probes: ProbeStanding[],
  spread?: ProbeSpread | null
): { next: 'ok' | 'firing'; transition: 'firing' | 'resolved' | null; breaching: number; total: number } {
  const total = probes.length;
  const breaching = probes.filter(probe => probe.inBreach && !probe.silent).length;
  const mostCharitable = probes.filter(probe => probe.inBreach || probe.silent).length;
  const reportingCount = probes.filter(probe => !probe.silent).length;
  const reporting = reportingCount > 0;
  // "Two thirds of the probes that are up" counts the silent ones out of the
  // pool to fire. To resolve they are in it, as in breach, as before: that is
  // never less than the share needed to fire, so the two cannot both hold.
  const pool = policy.kind === 'share' && policy.of === 'healthy' ? reportingCount : total;
  const spread_ = spreadHolds(spread, probes.filter(probe => probe.inBreach && !probe.silent));

  if (state === 'ok' && reporting && spread_ && policyHolds(policy, breaching, pool)) {
    return { next: 'firing', transition: 'firing', breaching, total };
  }
  if (state === 'firing' && !policyHolds(policy, mostCharitable, total)) {
    return { next: 'ok', transition: 'resolved', breaching, total };
  }
  return { next: state, transition: null, breaching, total };
}

/** The policy in words: "any probe", "at least 4 of 7 probes". */
export function describePolicy(policy: ProbePolicy, total: number): string {
  switch (policy.kind) {
    case 'any':
      return 'any probe';
    case 'all':
      return total > 1 ? `all ${total} probes` : 'the probe';
    case 'atLeast':
      return `at least ${policy.count} of ${total} probes`;
    case 'share':
      return policy.of === 'healthy'
        ? `at least ${policy.percent}% of the ${total} probes that are reporting (${Math.ceil((policy.percent / 100) * total)})`
        : `at least ${policy.percent}% of ${total} probes (${Math.ceil((policy.percent / 100) * total)})`;
  }
}

/** The spread in words: "from at least 3 regions and 2 networks"; empty when none is asked. */
export function describeSpread(spread: ProbeSpread | null | undefined): string {
  const parts = [
    spread?.regions ? `${spread.regions} region${spread.regions === 1 ? '' : 's'}` : '',
    spread?.networks ? `${spread.networks} network${spread.networks === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `from at least ${parts.join(' and ')}` : '';
}
