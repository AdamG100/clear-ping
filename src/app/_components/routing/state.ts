import type { BadgeTone } from '@/components/arc/badge/badge'
import { BGP_DIRECT, type BgpConnectionState, type BgpState } from '@/types/bgp'

/** How each state of a prefix is named and coloured on the routing pages. */

export const STATE_LABEL: Record<BgpState, string> = {
  learning: 'Learning',
  normal: 'Normal',
  diverted: 'Diverted',
  partial: 'Partly withdrawn',
  withdrawn: 'Withdrawn',
  hijack: 'Suspected hijack',
}

export const STATE_TONE: Record<BgpState, BadgeTone> = {
  learning: 'neutral',
  normal: 'success',
  diverted: 'warning',
  partial: 'warning',
  withdrawn: 'danger',
  hijack: 'danger',
}

/** The same, as a colour for a dot or an edge. */
export const STATE_COLOR: Record<BgpState, string> = {
  learning: 'var(--signal-none)',
  normal: 'var(--signal-perfect)',
  diverted: 'var(--signal-moderate)',
  partial: 'var(--signal-minor)',
  withdrawn: 'var(--signal-critical)',
  hijack: 'var(--signal-critical)',
}

export const CONNECTION_LABEL: Record<BgpConnectionState, string> = {
  off: 'Off',
  connecting: 'Connecting to RIS Live',
  live: 'Live from RIS Live',
  offline: 'RIS Live unreachable, retrying',
}

export const CONNECTION_TONE: Record<BgpConnectionState, BadgeTone> = {
  off: 'neutral',
  connecting: 'info',
  live: 'success',
  offline: 'warning',
}

/** Where the routes come from, said plainly: not from the user's own network. */
export const SOURCE_NOTE =
  'The routes RIPE NCC’s RIS route collectors receive from their peers at internet exchanges around the world: read from RIPEstat (stat.ripe.net), and kept current from RIS Live (ris-live.ripe.net). Where RIS has no collector and the prefix is offered at an exchange, that exchange’s own route collector, read from its looking glass (INX-ZA’s, lg.inx.net.za, for South Africa’s exchanges). They show how other networks reach a prefix, not what your own routers see.'

/** AS64501, with the network's name when it is known. */
export function asLabel(asn: number, names: Record<number, string>): string {
  const name = names[asn]
  return name ? `AS${asn} ${name}` : `AS${asn}`
}

/**
 * What a peer reaches the origin through: an upstream, or nothing at all
 * ("Directly connected"), for peers that connect to it themselves, at an
 * exchange, privately, or as its upstream.
 */
export function carrierLabel(asn: number, names: Record<number, string>): string {
  return asn === BGP_DIRECT ? 'Directly connected' : asLabel(asn, names)
}

/** The same, short, after "seen": "direct", "via AS64502". */
export function viaLabel(asn: number): string {
  return asn === BGP_DIRECT ? 'direct' : `via AS${asn}`
}

/**
 * Whose a network of yours is, said plainly: "Your ISP" for this server's,
 * which is the network you set as yours; "Probe agent London" for one of
 * theirs. `whose` is as the server gives it: "This server", or the agent's name.
 */
export function whoseLabel(whose: string): string {
  return whose === 'This server' ? 'Your ISP' : `Probe agent ${whose}`
}

/** The same with the network: "Your ISP, AS64500 Example ISP". */
export function whoseNetwork(whose: string, asn: number, names: Record<number, string>): string {
  return `${whoseLabel(whose)}, ${asLabel(asn, names)}`
}

/** Every one of yours among these networks, labelled once each: "Your ISP, Probe agent London". */
export function whoseAmong(asns: Iterable<number>, mine: Record<number, string>): string[] {
  return [...new Set([...asns].filter(asn => asn in mine).map(asn => whoseLabel(mine[asn])))]
}

/** "3 minutes ago", "2 hours ago", for when a route last changed. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} days ago`
}
