import { isValidHost, normalizeHost } from '../probes/host';
import { PROBE_AGENT_DEFAULT_PORT } from './protocol';

/**
 * Checking a probe agent as it is added or changed. Pure: the form checks as
 * it is filled in, and the server checks again before storing.
 */

export interface ProbeAgentInput {
  name: string;
  address: string;
  port: number;
}

export const PROBE_AGENT_NAME_MAX = 60;

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export function readProbeAgentName(raw: unknown): Checked<string> {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > PROBE_AGENT_NAME_MAX) {
    return { ok: false, error: `Give the probe agent a name of up to ${PROBE_AGENT_NAME_MAX} characters, such as where it is` };
  }
  return { ok: true, value: name };
}

/** A hostname or an IP address, with any brackets or port written on it taken off. */
export function readProbeAgentAddress(raw: unknown): Checked<string> {
  const written = typeof raw === 'string' ? raw.trim() : '';
  const bare = /^\[(.+)\](?::\d+)?$/.exec(written)?.[1] ?? written;
  const address = normalizeHost(bare);
  if (!address || !isValidHost(address)) {
    return { ok: false, error: 'The address is the probe agent machine’s hostname or IP address, such as 100.64.0.7' };
  }
  return { ok: true, value: address };
}

export function readProbeAgentPort(raw: unknown): Checked<number> {
  const port = raw === undefined || raw === '' ? PROBE_AGENT_DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'The port is a number from 1 to 65535' };
  return { ok: true, value: port };
}

/** The whole of a new probe agent, or the first thing wrong with it. */
export function readProbeAgentInput(raw: unknown): Checked<ProbeAgentInput> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = readProbeAgentName(input.name);
  if (!name.ok) return name;
  const address = readProbeAgentAddress(input.address);
  if (!address.ok) return address;
  const port = readProbeAgentPort(input.port);
  if (!port.ok) return port;
  return { ok: true, value: { name: name.value, address: address.value, port: port.value } };
}
