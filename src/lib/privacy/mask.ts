import { isAddress } from '../bgp/prefix'

/**
 * Hiding addresses: IP addresses and host names, in what is shown on screen
 * and what AI assistants are given. Pure, so the browser and the server mask
 * alike.
 *
 * Enough is kept to tell one from another at a glance (the last part of an
 * IP address, the first letter and the top-level domain of a name) and
 * nothing that says where it is. Every hidden part is the same three dots,
 * so not even its length is given away.
 */

const DOTS = '•••'

function maskIpv4(address: string): string {
  return `${DOTS}.${DOTS}.${DOTS}.${address.split('.').at(-1)}`
}

function maskIpv6(address: string): string {
  const last = address.split(':').filter(Boolean).at(-1) ?? ''
  return `${DOTS}:${DOTS}::${last}`
}

function maskName(name: string): string {
  const labels = name.split('.')
  if (labels.length === 1) return `${name.charAt(0)}${DOTS}`
  const tld = labels.at(-1)
  return [`${labels[0].charAt(0)}${DOTS}`, ...labels.slice(1, -1).map(() => DOTS), tld].join('.')
}

/**
 * One address as a target, probe agent or hop has it: an IP address, a name,
 * either with a port (`host:443`, `[2001:db8::1]:443`), or a URL, whose path
 * is hidden too.
 */
export function maskAddress(value: string): string {
  const text = value.trim()
  if (!text) return value

  const url = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]+)(.*)$/i.exec(text)
  if (url) {
    const [, scheme, authority, rest] = url
    return `${scheme}${maskAddress(authority.replace(/^[^@]*@/, ''))}${rest && rest !== '/' ? '/…' : rest}`
  }

  const bracketed = /^\[([^\]]+)\](:\d+)?$/.exec(text)
  if (bracketed) return `[${maskAddress(bracketed[1])}]${bracketed[2] ?? ''}`

  if (isAddress(text)) return text.includes(':') ? maskIpv6(text) : maskIpv4(text)

  const withPort = /^([^:]+):(\d+)$/.exec(text)
  if (withPort) return `${maskAddress(withPort[1])}:${withPort[2]}`

  return maskName(text)
}

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g
// Anything shaped like an IPv6 address; checked properly before it is hidden,
// so a time such as 18:19:05 is left alone.
const IPV6 = /(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi
const NAME = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi

/**
 * Every IP address in a piece of text, hidden, and with `names`, every host
 * name too. Names are only looked for when asked: in running text "next.js"
 * or "e.g." look like them.
 */
export function maskText(text: string, { names = false, known = [] }: { names?: boolean; known?: readonly string[] } = {}): string {
  let masked = text
  for (const host of known) {
    if (host.length > 3 && masked.includes(host)) masked = masked.split(host).join(maskAddress(host))
  }
  masked = masked
    .replace(IPV4, match => (isAddress(match) ? maskIpv4(match) : match))
    .replace(IPV6, match => (match.includes('::') || match.split(':').length === 8) && isAddress(match) ? maskIpv6(match) : match)
  return names ? masked.replace(NAME, match => maskName(match)) : masked
}

/** The keys in what assistants are given whose values are addresses, hidden whole. */
const ADDRESS_KEYS = new Set(['host', 'hostname', 'address', 'resolvedAddress', 'addresses', 'ip'])

/**
 * A tool's answer with its addresses hidden: every value under an address key
 * in full, and IP addresses and the `known` names wherever else they turn up
 * (an error message, a resolver's label, a summary).
 */
export function maskForAssistant<T>(value: T, known: readonly string[] = [], key?: string): T {
  if (typeof value === 'string') {
    return (key && ADDRESS_KEYS.has(key) ? maskAddress(value) : maskText(value, { known })) as T
  }
  if (Array.isArray(value)) return value.map(item => maskForAssistant(item, known, key)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, maskForAssistant(inner, known, name)])) as T
  }
  return value
}
