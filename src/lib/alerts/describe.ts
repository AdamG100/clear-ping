import type { AlertSettings } from '@/types/probe';
import { describeCondition } from './delivery';
import { conditionsOf, describeSpread, policyOf } from './rules';

/** The probes an alert needs to agree, in words, without a count of how many there are. */
export function policyPhrase(alert: Pick<AlertSettings, 'policy'>): string {
  const policy = policyOf(alert);
  switch (policy.kind) {
    case 'any':
      return '';
    case 'all':
      return 'every probe';
    case 'atLeast':
      return `at least ${policy.count} probes`;
    case 'share':
      return policy.of === 'healthy' ? `at least ${policy.percent}% of probes that are reporting` : `at least ${policy.percent}% of probes`;
  }
}

/**
 * The whole of an alert's rule on one line, as its card says it: "Packet loss
 * above 5% and Latency above 200 ms, for 5 minutes, at least 4 probes".
 */
export function describeRule(alert: Pick<AlertSettings, 'metric' | 'threshold' | 'conditions' | 'combine' | 'forMinutes' | 'clearAfter' | 'consecutiveProbes' | 'policy' | 'spread' | 'probes' | 'scope'>): string {
  const conditions = conditionsOf(alert).map(describeCondition);
  const combine = alert.combine ?? 'any';
  const joined =
    conditions.length === 1 ? conditions[0]
    : combine === 'any' ? conditions.join(' or ')
    : combine === 'all' ? conditions.join(' and ')
    : `at least ${combine.atLeast} of: ${conditions.join(', ')}`;

  const duration = alert.forMinutes
    ? `for ${alert.forMinutes} minute${alert.forMinutes === 1 ? '' : 's'}`
    : alert.consecutiveProbes === 1 ? 'on a single reading' : `for ${alert.consecutiveProbes} readings in a row`;
  const clears = alert.clearAfter ? `clears after ${alert.clearAfter} ${alert.forMinutes ? 'minutes' : 'readings'}` : '';
  const scope = (alert.scope ?? []).filter(entry => entry.kind !== 'monitor');
  const where = scope.length > 0 ? `also ${scope.length} ${scope.length === 1 ? 'place' : 'places'} by group or probe` : '';
  const only = alert.probes && alert.probes.length > 0 ? `counting ${alert.probes.length} probe${alert.probes.length === 1 ? '' : 's'}` : '';

  return [joined, duration, clears, [policyPhrase(alert), describeSpread(alert.spread)].filter(Boolean).join(' '), only, where].filter(Boolean).join(', ');
}
