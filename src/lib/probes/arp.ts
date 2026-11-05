import { execFile } from 'child_process';
import { networkInterfaces } from 'os';
import type { ProbeResult } from '@/types/probe';
import { arpingArgs, arpingFailure, parseArpingOutput } from './arp/parse';
import { localLinkFor } from './arp/subnet';
import { classifyHost, normalizeHost } from './host';
import { logReading } from './log';
import { failedProbe, summarizeProbe } from './result';
import { resolveHost } from './resolve';

/**
 * ARP probe: whether a device on the same network is there, and how the link
 * to it is doing, whatever it does with ping.
 *
 * Phones, printers and hosts with a firewall on often drop or rate-limit ICMP,
 * and the ping probe shows them as down or lossy when they are fine. Nothing
 * on a network can talk without answering ARP, so a reply says the device is
 * there. Readings are the ping probe's: loss, latency and jitter over a number
 * of requests.
 *
 * - IPv4 only. IPv6 finds its neighbours another way (Neighbor Discovery).
 * - Same network only: ARP does not cross a router. An address on none of this
 *   machine's networks fails with a reason (./arp/subnet) rather than 100% loss.
 * - Linux only, through iputils `arping`, which needs CAP_NET_RAW as `ping`
 *   does. Debian's package gives the program the capability itself.
 *
 * Each request is a run of `arping` of its own, one after another, for the
 * reason in ./arp/parse. A lost request takes the whole timeout, so loss is
 * scored as it is for ping: what was sent and not answered in time.
 */

export interface ArpOptions {
  /** Requests a probe sends. */
  count?: number;
  /** How long one request is waited on, in milliseconds. Rounded up to a whole second for `arping`. */
  timeout?: number;
  /** Pause between requests, in milliseconds. */
  interval?: number;
  /** Hard ceiling on the whole probe, in milliseconds. */
  maxDuration?: number;
}

const DEFAULTS = { count: 20, timeout: 1000, interval: 10 } as const;

interface Sent {
  received: boolean;
  latency: number | null;
  /** Set when `arping` could not ask at all, which ends the probe. */
  fatal?: string;
}

function sendRequest(address: string, device: string, timeoutMs: number): Promise<Sent> {
  return new Promise(resolve => {
    try {
      execFile('arping', arpingArgs(address, device, timeoutMs), { timeout: timeoutMs + 2000, windowsHide: true }, (error, stdout, stderr) => {
        const code = (error as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
        const fatal = arpingFailure(code ?? (error ? undefined : 0), stderr);
        if (fatal) {
          resolve({ received: false, latency: null, fatal });
          return;
        }
        const parsed = parseArpingOutput(stdout, address);
        resolve({ received: parsed.received, latency: parsed.latency });
      });
    } catch (error) {
      // A program the system will not start at all (EPERM where CAP_NET_RAW is
      // dropped) is thrown here, not handed to the callback.
      const code = (error as NodeJS.ErrnoException).code;
      resolve({ received: false, latency: null, fatal: arpingFailure(code, '') ?? `arping could not start (${code ?? 'unknown error'})` });
    }
  });
}

/** Run an ARP probe against one host. Never throws: a failure is in the result. */
export async function executeArp(targetId: string, host: string, options: ArpOptions = {}): Promise<ProbeResult> {
  const count = Math.max(1, Math.floor(options.count ?? DEFAULTS.count));
  const timeout = Math.max(1000, Math.floor(options.timeout ?? DEFAULTS.timeout));
  const interval = Math.max(0, Math.floor(options.interval ?? DEFAULTS.interval));
  const maxDuration = options.maxDuration ?? count * (timeout + interval) + 2000;

  const timestamp = new Date();
  const failed = (errorMessage: string, resolvedAddress?: string) => failedProbe(targetId, timestamp, errorMessage, { resolvedAddress });

  if (process.platform !== 'linux') {
    return failed('ARP probes run on Linux only. Probe it from a probe agent on Linux on the same network.');
  }

  const name = normalizeHost(host);
  const kind = classifyHost(name);
  if (kind === 'invalid') return failed(`Invalid host: ${host}`);
  if (kind === 'ipv6') return failed('ARP is IPv4 only: an IPv6 address has no ARP to answer.');

  let address = name;
  if (kind === 'hostname') {
    const resolved = await resolveHost(name, 'ipv4');
    if (!resolved.ok) return failed(resolved.error);
    address = resolved.address;
  }
  const resolvedAddress = kind === 'hostname' ? address : undefined;
  const label = kind === 'hostname' ? `${name} (${address})` : name;

  const link = localLinkFor(address, networkInterfaces());
  if (!link.ok) return failed(link.error, resolvedAddress);

  const deadline = Date.now() + maxDuration;
  const latencies: number[] = [];
  let sent = 0;

  for (let i = 0; i < count; i++) {
    if (Date.now() >= deadline) {
      console.warn(`[ARP] ${label}: deadline reached after ${sent}/${count} requests`);
      break;
    }
    const reply = await sendRequest(address, link.device, timeout);
    if (reply.fatal) return failed(reply.fatal, resolvedAddress);
    sent++;
    if (reply.received && reply.latency !== null) latencies.push(reply.latency);
    if (i < count - 1 && interval > 0) await new Promise(resolve => setTimeout(resolve, interval));
  }

  if (sent === 0) return failed('Probe deadline exceeded before any request was sent', resolvedAddress);

  const result = summarizeProbe({
    targetId,
    timestamp,
    latencies,
    attempted: sent,
    failureReason: `No ARP reply on ${link.device}`,
    resolvedAddress,
  });

  logReading(
    result,
    `[ARP] ${label} via ${link.device}: sent=${sent} received=${latencies.length} loss=${result.packetLoss}% ` +
      `avg=${result.latency ?? '-'}ms jitter=${result.jitter ?? '-'}ms`
  );
  return result;
}
