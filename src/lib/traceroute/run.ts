import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import type { ProbeIpVersion, Target, Traceroute } from '@/types/probe';
import { classifyHost, normalizeHost, type AddressFamily } from '../probes/host';
import { resolveHost } from '../probes/resolve';
import { parseTraceroute, traceReached, tracerouteCommand } from './parse';

/**
 * Tracing a route, and nothing else: no database. A probe agent runs this on
 * another machine and sends the trace back, so it must stay free of anything
 * that only the dashboard has.
 */

/** Hard ceiling on one trace. A partial trace is still parsed and kept. */
const TRACE_TIMEOUT_MS = 90_000

/** Spawn the system traceroute and return whatever it printed, complete or not. */
function runCommand(command: string, args: string[]): Promise<{ stdout: string; error?: string }> {
  return new Promise(resolve => {
    execFile(command, args, { timeout: TRACE_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout });
        return;
      }

      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      const reason =
        failure.code === 'ENOENT'
          ? `${command} is not installed on this machine`
          : failure.killed
            ? `Stopped after ${TRACE_TIMEOUT_MS / 1000}s without finishing`
            : (stderr || failure.message).trim().split(/\r?\n/)[0];

      // The hops traced before a timeout are exactly the useful part.
      resolve({ stdout: stdout ?? '', error: reason });
    });
  });
}

/**
 * Trace the route to a target over one address family. Never throws; a
 * failure is recorded in the result.
 */
export async function runTraceroute(
  target: Pick<Target, 'id' | 'host'>,
  trigger: Traceroute['trigger'],
  ipVersion: ProbeIpVersion = 'auto'
): Promise<Traceroute> {
  const base = { id: randomUUID(), targetId: target.id, timestamp: new Date(), trigger };
  const host = normalizeHost(target.host);
  const kind = classifyHost(host);

  if (kind === 'invalid') {
    return { ...base, address: host, hops: [], reached: false, errorMessage: `Invalid host: ${target.host}` };
  }

  let address = host;
  let family: AddressFamily = kind === 'ipv6' ? 6 : 4;

  // Resolved here, as the probes do, so the trace follows the same address
  // family the target is actually monitored over.
  if (kind === 'hostname') {
    const resolved = await resolveHost(host, ipVersion);
    if (!resolved.ok) {
      return { ...base, address: host, hops: [], reached: false, errorMessage: resolved.error };
    }
    address = resolved.address;
    family = resolved.family;
  }

  const icmp = tracerouteCommand(address, family);
  let { stdout, error } = await runCommand(icmp.command, icmp.args);
  let hops = parseTraceroute(stdout);

  // ICMP without root takes the kernel allowing it (Docker does, through
  // ping_group_range); where it does not, traceroute fails at once with
  // nothing traced. UDP needs no privilege, and is better than no trace.
  if (hops.length === 0 && process.platform !== 'win32') {
    const udp = tracerouteCommand(address, family, undefined, 'udp');
    ({ stdout, error } = await runCommand(udp.command, udp.args));
    hops = parseTraceroute(stdout);
  }

  return {
    ...base,
    address,
    hops,
    reached: traceReached(hops, address),
    // An error alongside hops means "cut short", which the hops already show.
    errorMessage: hops.length === 0 ? error ?? 'Traceroute produced no output' : undefined,
  };
}
