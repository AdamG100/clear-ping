import type { ProbeAgentExposure } from '@/types/probe-agent';
import { classifyHost, isLocalHost, isPrivateAddress, normalizeHost } from '../probes/host';

/**
 * How a probe agent is reached, from the address it was given.
 *
 * - `tailnet`: a Tailscale address or name. WireGuard encrypts the path and
 *   nobody outside the tailnet can reach the port at all.
 * - `private`: a private network (home, office, a VPC). Not reachable from the
 *   internet, unless someone forwards the port.
 * - `public`: the open internet. The link is still encrypted and the agent
 *   still only answers the token, but the port is open to anyone who finds it,
 *   and closing it to all but the dashboard is the job of the agent's firewall.
 *
 * Pure, with no Node imports: the add form shows the verdict as it is typed.
 * A name that is neither a Tailscale name nor obviously local is judged by
 * what it resolves to, on the server (see probe-agents/client.ts).
 */

/** Tailscale hands out 100.64.0.0/10 and fd7a:115c:a1e0::/48, and names under ts.net. */
export function isTailnetAddress(address: string): boolean {
  const host = normalizeHost(address).toLowerCase();
  if (host.endsWith('.ts.net')) return true;
  const kind = classifyHost(host);
  if (kind === 'ipv4') {
    const [a, b] = host.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  if (kind === 'ipv6') return /^fd7a:115c:a1e0:/.test(host);
  return false;
}

/** The verdict from the address as written, before any name is looked up. */
export function exposureOfAddress(address: string): ProbeAgentExposure {
  const host = normalizeHost(address);
  if (isTailnetAddress(host)) return 'tailnet';
  if (classifyHost(host) !== 'hostname') return isPrivateAddress(host) ? 'private' : 'public';
  return isLocalHost(host) ? 'private' : 'public';
}

export const EXPOSURE_LABEL: Record<ProbeAgentExposure, string> = {
  tailnet: 'Tailnet',
  private: 'Private network',
  public: 'Internet',
};
