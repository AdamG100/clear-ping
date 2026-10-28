import type { BadgeTone } from '@/components/arc/badge/badge'
import { BGP_DIRECT, type BgpConnectionState, type BgpState, type BgpVantage } from '@/types/bgp'

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

/** A vantage point, said the same way: "Your ISP" for this server, "Probe agent London". */
export function vantageLabel(vantage: Pick<BgpVantage, 'kind' | 'name'>): string {
  return whoseLabel(vantage.kind === 'server' ? 'This server' : vantage.name)
}

/** Where one of your vantage points' traffic went, by its newest trace, and where it is. */
export interface YourTrace {
  whose: string
  path: number[]
  place: BgpVantage['place']
  /** Whether its network shares its routes with RIS: then those are drawn, and this is not. */
  hasRoutes: boolean
}

/**
 * Your networks as the page marks them: each network, and whose it is said
 * plainly ("Your ISP", "Probe agent London", or both, where two of yours are
 * on one network); and the way each vantage point's traffic went.
 */
export function yoursOf(vantages: readonly BgpVantage[]): { mine: Record<number, string>; traced: YourTrace[] } {
  const owners = new Map<number, string[]>()
  for (const vantage of vantages) {
    for (const asn of vantage.asns) owners.set(asn, [...new Set([...(owners.get(asn) ?? []), vantageLabel(vantage)])])
  }
  return {
    mine: Object.fromEntries([...owners].map(([asn, whose]) => [asn, whose.join(', ')])),
    traced: vantages
      .filter(vantage => (vantage.tracedPath ?? []).length > 0)
      .map(vantage => ({ whose: vantageLabel(vantage), path: vantage.tracedPath, place: vantage.place ?? null, hasRoutes: vantage.routes.some(peer => peer.route) })),
  }
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
