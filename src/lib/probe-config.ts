import type { DnsRecordType, ProbeConfig, ProbeType, Target } from '@/types/probe'
import { classifyHost, isIpv6, normalizeHost } from './host'

/**
 * Per-probe settings: reading them out of what the user typed, checking them,
 * and turning them back into something to display.
 *
 * A target's `host` is always a bare address or name, whatever the probe.
 * Everything else a probe needs — the port to connect to, the path to request,
 * the name to ask a DNS server for — lives in its `ProbeConfig`. Keeping the
 * host bare is what lets address-family selection, name resolution and the
 * IP/domain distinction work identically for every probe.
 *
 * Pure, with no Node imports: the add-target dialog runs this as you type.
 */

export const PROBE_TYPES: readonly ProbeType[] = ['ping', 'tcp', 'http', 'dns']

export const DNS_RECORD_TYPES: readonly DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT']

export function isProbeType(value: unknown): value is ProbeType {
  return PROBE_TYPES.includes(value as ProbeType)
}

export const DEFAULT_DNS_QUERY_NAME = 'example.com'

const DEFAULT_PORT = { http: 80, https: 443 } as const

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

export interface ParsedAddress {
  /** The bare host, ready to store. */
  host: string
  /** The probe the input's shape implies, if it implies one. */
  probeType?: ProbeType
  /** Settings carried by the input itself: a port, a scheme, a path. */
  config: ProbeConfig
}

/**
 * Split what was typed into the address box into a host and whatever else it
 * carried. People paste `https://example.com/health` and `db.internal:5432`,
 * and both say unambiguously which probe is wanted.
 */
export function parseAddressInput(input: string): ParsedAddress {
  const trimmed = (input ?? '').trim()

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const scheme = url.protocol === 'http:' ? 'http' : 'https'
      const config: ProbeConfig = { scheme, path: `${url.pathname || '/'}${url.search}` }
      if (url.port) config.port = Number(url.port)
      // URL keeps the brackets on an IPv6 host; normalizeHost takes them off.
      return { host: normalizeHost(url.hostname), probeType: 'http', config }
    } catch {
      return { host: trimmed, config: {} }
    }
  }

  // "[2001:db8::1]:443" — the only way to attach a port to an IPv6 literal.
  const bracketed = /^\[(.+)\]:(\d{1,5})$/.exec(trimmed)
  if (bracketed && isIpv6(bracketed[1]) && isPort(Number(bracketed[2]))) {
    return { host: bracketed[1], probeType: 'tcp', config: { port: Number(bracketed[2]) } }
  }

  // "host:443". A bare IPv6 literal has colons too, but never exactly one.
  const withPort = /^([^:\s]+):(\d{1,5})$/.exec(trimmed)
  if (withPort && isPort(Number(withPort[2])) && classifyHost(withPort[1]) !== 'invalid') {
    return { host: withPort[1], probeType: 'tcp', config: { port: Number(withPort[2]) } }
  }

  return { host: normalizeHost(trimmed), config: {} }
}

export type ConfigValidation =
  | { ok: true; config: ProbeConfig }
  | { ok: false; error: string }

/**
 * Check a config against the probe it is for, and reduce it to the fields that
 * probe uses. Returning a fresh object rather than the input is deliberate: a
 * target switched from HTTP to TCP must not keep a path nobody can see or edit.
 */
export function validateProbeConfig(probeType: ProbeType, host: string, raw: unknown): ConfigValidation {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const config: ProbeConfig = {}

  switch (probeType) {
    case 'ping':
      return { ok: true, config }

    case 'tcp': {
      if (!isPort(input.port)) {
        return { ok: false, error: 'A TCP target needs a port between 1 and 65535' }
      }
      return { ok: true, config: { port: input.port } }
    }

    case 'http': {
      const scheme = input.scheme ?? 'https'
      if (scheme !== 'http' && scheme !== 'https') {
        return { ok: false, error: 'Scheme must be http or https' }
      }
      config.scheme = scheme

      if (input.port !== undefined && input.port !== null) {
        if (!isPort(input.port)) return { ok: false, error: 'Port must be between 1 and 65535' }
        if (input.port !== DEFAULT_PORT[scheme]) config.port = input.port
      }

      const path = text(input.path) || '/'
      if (!path.startsWith('/') || /\s/.test(path)) {
        return { ok: false, error: 'Path must start with / and contain no spaces' }
      }
      config.path = path

      if (input.expectedStatus !== undefined && input.expectedStatus !== null) {
        const status = input.expectedStatus
        if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
          return { ok: false, error: 'Expected status must be an HTTP status code (100-599)' }
        }
        config.expectedStatus = status
      }

      const keyword = text(input.keyword)
      if (keyword.length > 200) return { ok: false, error: 'Keyword must be 200 characters or fewer' }
      if (keyword) config.keyword = keyword

      return { ok: true, config }
    }

    case 'dns': {
      const isServer = classifyHost(host) !== 'hostname'

      // Only a server target has a choice of what to ask: a name target is the
      // question, and it is looked up as an address through the system resolver.
      if (isServer) {
        const queryName = text(input.queryName)
        if (queryName) {
          if (classifyHost(queryName) !== 'hostname') {
            return { ok: false, error: 'Query name must be a hostname' }
          }
          config.queryName = queryName
        }

        if (input.recordType !== undefined && input.recordType !== null) {
          if (!DNS_RECORD_TYPES.includes(input.recordType as DnsRecordType)) {
            return { ok: false, error: `Record type must be one of: ${DNS_RECORD_TYPES.join(', ')}` }
          }
          config.recordType = input.recordType as DnsRecordType
        }
      }

      const expectedAnswer = text(input.expectedAnswer)
      if (expectedAnswer.length > 255) {
        return { ok: false, error: 'Expected answer must be 255 characters or fewer' }
      }
      if (expectedAnswer) config.expectedAnswer = expectedAnswer

      return { ok: true, config }
    }
  }
}

/** A host as it has to be written inside a URL or before a port. */
function bracketIfIpv6(host: string): string {
  return isIpv6(host) ? `[${host}]` : host
}

/** The URL an HTTP target requests. */
export function httpUrlFor(host: string, config: ProbeConfig = {}): string {
  const scheme = config.scheme ?? 'https'
  const port = config.port && config.port !== DEFAULT_PORT[scheme] ? `:${config.port}` : ''
  return `${scheme}://${bracketIfIpv6(host)}${port}${config.path ?? '/'}`
}

/**
 * The address to show for a target: what a person would type to reach the
 * thing being probed, port or URL included.
 */
export function targetAddressLabel(target: Pick<Target, 'host' | 'probeType' | 'probeConfig'>): string {
  const config = target.probeConfig ?? {}

  if (target.probeType === 'http') return httpUrlFor(target.host, config)
  if (target.probeType === 'tcp' && config.port) return `${bracketIfIpv6(target.host)}:${config.port}`
  return target.host
}
