import type { IpVersion, ProbeConfig, Target, TargetDefinition } from '@/types/probe'
import { normalizeGroupPath } from './group-path'
import { classifyHost, IP_VERSIONS, isIpVersion, isValidHost, normalizeHost } from '../probes/host'
import { ipVersionProblem, isProbeType, PROBE_TYPES, validateProbeConfig } from '../probes/config'

/**
 * Checking what a new target is made of.
 *
 * One target typed into the form and fifty arriving in a share link are held
 * to the same rules, so the rules are here rather than in either route.
 *
 * Pure, with no Node imports: an import is checked in the browser before it is
 * offered, and again by the server before it is stored.
 */

export type DefinitionValidation =
  | { ok: true; target: TargetDefinition }
  | { ok: false; error: string }

export function validateTargetDefinition(raw: unknown): DefinitionValidation {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const { host, probeType, interval, ipVersion } = input
  const name = typeof input.name === 'string' ? input.name.trim() : ''

  if (!name || !host || !probeType || !interval) {
    return { ok: false, error: 'Missing required fields' }
  }

  if (!isProbeType(probeType)) {
    return { ok: false, error: `Invalid probe type. Expected one of: ${PROBE_TYPES.join(', ')}` }
  }

  // Reject hosts the probe could never use, rather than storing a target that
  // records 100% loss forever.
  if (typeof host !== 'string' || !isValidHost(host)) {
    return { ok: false, error: 'Invalid host: must be a hostname or an IPv4/IPv6 address' }
  }

  if (ipVersion !== undefined && !isIpVersion(ipVersion)) {
    return { ok: false, error: `Invalid IP version. Expected one of: ${IP_VERSIONS.join(', ')}` }
  }
  const familyProblem = ipVersionProblem(probeType, ipVersion as IpVersion | undefined)
  if (familyProblem) return { ok: false, error: familyProblem }

  const intervalSeconds = Number(interval)
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 86400) {
    return { ok: false, error: 'Interval must be between 10 and 86400 seconds' }
  }

  // Checked against the probe it is for, and reduced to the settings that
  // probe uses: a TCP target without a port could never measure anything.
  const config = validateProbeConfig(probeType, host, input.probeConfig)
  if (!config.ok) return config

  const group = typeof input.group === 'string' ? normalizeGroupPath(input.group) : ''

  return {
    ok: true,
    target: {
      name,
      host: normalizeHost(host),
      probeType,
      ipVersion: ipVersion ?? 'auto',
      probeConfig: config.config,
      interval: intervalSeconds,
      ...(group ? { group } : {}),
    },
  }
}

/** A target with everything that belongs to this installation left behind. */
export function definitionOf(target: Target): TargetDefinition {
  const group = normalizeGroupPath(target.group)
  return {
    name: target.name,
    host: target.host,
    probeType: target.probeType,
    ipVersion: target.ipVersion ?? 'auto',
    probeConfig: target.probeConfig ?? {},
    interval: target.interval,
    ...(group ? { group } : {}),
  }
}

/** A probe's settings written the same way whatever order they were set in. */
function canonicalConfig(config: ProbeConfig): string {
  const entries = Object.entries(config).filter(([, value]) => value !== undefined)
  return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * What a target measures, as one string: two targets with the same one would
 * take the same readings, whatever they are called and wherever they are kept.
 */
export function measurementKey(target: Pick<Target, 'host' | 'probeType' | 'ipVersion' | 'probeConfig'>): string {
  // Only a name has a choice of family; on an address the setting means nothing.
  const ipVersion = classifyHost(target.host) === 'hostname' ? target.ipVersion ?? 'auto' : 'auto'
  return [target.probeType, target.host.toLowerCase(), ipVersion, canonicalConfig(target.probeConfig ?? {})].join('|')
}
