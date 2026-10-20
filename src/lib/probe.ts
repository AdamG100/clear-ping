import type { AddressFamily, ProbeIpVersion, ProbeResult, Target } from '@/types/probe';
import { executeDnsProbe } from './dns';
import { classifyHost, probeRuns } from './host';
import { executeHttpProbe } from './http-probe';
import { executePing } from './ping';
import { failedProbe } from './probe-result';
import { executeTcpProbe } from './tcp';

export type ProbeTarget = Pick<Target, 'id' | 'host' | 'probeType' | 'ipVersion' | 'probeConfig'>;

/** Run one probe of the kind a target is configured for, over one address family. */
function runProbe(target: ProbeTarget, ipVersion: ProbeIpVersion): Promise<ProbeResult> {
  const { id, host } = target;
  const config = target.probeConfig ?? {};

  switch (target.probeType) {
    case 'ping':
      return executePing(id, host, { ipVersion, count: config.packets });
    case 'dns':
      return executeDnsProbe(id, host, { ...config, ipVersion });
    case 'http':
      return executeHttpProbe(id, host, { ...config, ipVersion });
    case 'tcp':
      // The API refuses to store a TCP target without a port, but a row edited
      // by hand should fail with a reason rather than throw inside the scheduler.
      return config.port === undefined
        ? Promise.resolve(failedProbe(id, new Date(), 'No port configured for this TCP target'))
        : executeTcpProbe(id, host, { port: config.port, ipVersion });
  }
}

function familyOfAddress(address: string | undefined): AddressFamily | undefined {
  const kind = address ? classifyHost(address) : 'invalid';
  return kind === 'ipv4' ? 4 : kind === 'ipv6' ? 6 : undefined;
}

/**
 * Run one round of probing for a target.
 *
 * The one place that decides what a target's probe is, shared by the
 * scheduler and the "Probe now" endpoint so a manual probe can never measure
 * something different from the scheduled ones it is plotted alongside.
 *
 * Usually one result. A target set to both address families gets two, one per
 * family, taken at the same time and stamped with the same moment: they are
 * two readings of one round, and are stored, charted and compared as a pair.
 */
export async function executeProbes(target: ProbeTarget): Promise<ProbeResult[]> {
  const runs = probeRuns(target.host, target.ipVersion);
  const results = await Promise.all(runs.map(run => runProbe(target, run.ipVersion)));
  const timestamp = results[0].timestamp;

  return results.map((result, index) => ({
    ...result,
    timestamp,
    // Where the family was left to the resolver, it is whichever the probe
    // ended up measuring; unknown only if it never got as far as an address.
    family: runs[index].family ?? familyOfAddress(result.resolvedAddress),
  }));
}
