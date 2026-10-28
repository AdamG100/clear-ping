/**
 * BGP monitoring: the prefixes watched, how the world's route collectors see
 * them, and what that adds up to. Shared by the API and the routing pages.
 */

/**
 * Where a route collector is, by the five registries' service regions: the
 * regions the internet's addresses are handed out in, and a fair way to say
 * "seen from Africa" or "seen from Europe".
 */
export type BgpRegion = 'africa' | 'europe' | 'north-america' | 'latin-america' | 'asia-pacific'

export const BGP_REGIONS: readonly BgpRegion[] = ['africa', 'europe', 'north-america', 'latin-america', 'asia-pacific']

export const BGP_REGION_LABEL: Record<BgpRegion, string> = {
  africa: 'Africa',
  europe: 'Europe & Middle East',
  'north-america': 'North America',
  'latin-america': 'Latin America',
  'asia-pacific': 'Asia Pacific',
}

/**
 * How a prefix stands, worst last:
 * - `learning`: no picture of normal yet to judge against.
 * - `normal`: carried the way it was when it was added, or last accepted.
 * - `diverted`: a share of the world now reaches it through a network it did
 *   not use before, or a more-specific of it has appeared: what a DDoS
 *   mitigation moving the route looks like.
 * - `partial`: a good part of the collectors no longer see it.
 * - `withdrawn`: next to none of them do.
 * - `hijack`: a network other than its own is announcing it.
 */
export type BgpState = 'learning' | 'normal' | 'diverted' | 'partial' | 'withdrawn' | 'hijack'

/** One collector peer's route to the prefix or to a more-specific of it. */
export interface BgpRoute {
  /** The RIS collector, as RIPE names it: RRC19. */
  collector: string
  /** The peer of the collector that sent the route: an address. */
  peer: string
  peerAsn: number
  /** The announced prefix: the one watched, or a more-specific of it. */
  prefix: string
  /** The AS path as sent, from the peer to the origin. */
  path: number[]
  /** When this peer took this route, in ms. */
  since: number
}

/** What is normal for a prefix, taken when it is added and whenever it is accepted. */
export interface BgpBaseline {
  at: number
  /** The networks that announce it. */
  origins: number[]
  /** The networks the origin is reached through. */
  upstreams: number[]
  /** The collector peers that saw it, as collector|peer. */
  peers: string[]
  /** The prefixes announced within it: the watched one, and any more-specific. */
  prefixes: string[]
  /**
   * The peers that reached it directly, as collector|peer: networks that peer
   * with the origin, at an exchange or privately, rather than reaching it
   * through an upstream. Absent from a normal taken before it was recorded.
   */
  directPeers?: string[]
  /**
   * The exchanges where the origin offered it itself, to the exchange's own
   * route collector (see looking-glass.ts): JINX, CINX. Absent until the
   * looking glasses were first read for it.
   */
  exchanges?: string[]
}

export interface BgpPrefix {
  id: string
  /** The announced prefix watched: 203.0.113.0/24. */
  prefix: string
  label: string | null
  /** What was asked for, when it was an address inside the prefix. */
  address: string | null
  baseline: BgpBaseline | null
  createdAt: number
}

export interface BgpShare {
  seen: number
  total: number
}

/**
 * The "upstream" of a peer that reaches the origin directly: it peers with
 * it, at an exchange or privately, so no network stands between them.
 */
export const BGP_DIRECT = 0

export interface BgpUpstreamShare {
  /** The network before the origin, or BGP_DIRECT for the peers that reach it directly. */
  asn: number
  peers: number
  /** One of the networks it was reached through when normal was taken. */
  expected: boolean
}

/** A prefix judged: everything the list and the top of its page show. */
export interface BgpStatus {
  state: BgpState
  /** Why, in words: "Now reached through AS6939 by 34% of peers". */
  reasons: string[]
  visibility: BgpShare
  byRegion: Record<BgpRegion, BgpShare>
  upstreams: BgpUpstreamShare[]
  origins: number[]
  /** More-specifics announced now that were not there when normal was taken. */
  newPrefixes: string[]
  /** The newest route change any peer made, in ms. */
  lastChange: number | null
}

export interface BgpEvent {
  id: number
  prefixId: string
  at: number
  /**
   * `state`: how the prefix stands changed. `home`: the route your own
   * network has to it changed, whether or not that changed how it stands.
   */
  kind: 'state' | 'home'
  state: BgpState
  reasons: string[]
}

/** One update RIS Live delivered for the prefix: exactly what a peer announced or withdrew. */
export interface BgpUpdate {
  id: number
  at: number
  collector: string
  location: string
  peer: string
  /** The peer's network, from the path it announced or the one it withdrew. 0 when neither is known. */
  peerAsn: number
  /** The prefix announced or withdrawn: the one watched, or a more-specific of it. */
  prefix: string
  kind: 'announce' | 'withdraw'
  /** The path announced; null for a withdrawal. */
  path: number[] | null
  /** The path this peer had for that prefix before: null when it had none, absent when that is not known. */
  previousPath?: number[] | null
}

/** How many updates arrived in a stretch of time, for the activity strip. */
export interface BgpActivity {
  start: number
  announcements: number
  withdrawals: number
}

export type BgpConnectionState = 'off' | 'connecting' | 'live' | 'offline'

export interface BgpConnection {
  state: BgpConnectionState
  /** Since when it has been in that state, in ms. */
  since: number
  /** The newest message from RIS Live, in ms. */
  lastMessageAt: number | null
  error: string | null
}

export interface BgpPrefixSummary extends BgpPrefix {
  status: BgpStatus
}

export interface BgpOverview {
  enabled: boolean
  connection: BgpConnection
  prefixes: BgpPrefixSummary[]
  asNames: Record<number, string>
  /** Your own network's AS numbers, for "From your network". */
  homeAsns: number[]
}

/** A collector peer as the prefix page lists it: its route, or the lack of one. */
export interface BgpPeerRoute {
  collector: string
  location: string
  /**
   * Where the peer sees from, as an ISO 3166 code: its exchange's country, or
   * for a multihop collector the country its network is registered in.
   */
  country: string
  region: BgpRegion
  peer: string
  peerAsn: number
  /** Null when this peer saw the prefix when normal was taken and no longer does. */
  route: BgpRoute | null
  /**
   * Whether its route is the one that counts for who carries it: the most
   * specific holding the address watched, or the prefix's own.
   */
  effective: boolean
}

/** An internet exchange, as PeeringDB lists it. */
export interface BgpExchange {
  name: string
  city: string
  country: string
}

/** Where a traceroute crossed an exchange: the hop whose address is on its peering LAN. */
export interface BgpCrossing extends BgpExchange {
  address: string
  hop: number
}

/** The latest traceroute from a vantage point to an address inside the prefix. */
export interface BgpHomeTrace {
  /** Where it was traced to: one of your targets in the prefix, or an address in it. */
  address: string
  /** The target with that address, when one of yours has it. */
  targetName: string | null
  at: number
  reached: boolean
  error: string | null
  hops: { hop: number; address: string | null; hostname: string | null; rtt: number | null; exchange: string | null }[]
  /** The exchange it crossed, or null when it crossed none it could name. */
  crossing: BgpCrossing | null
  /** The last trace before it that crossed somewhere else, if one is kept. */
  before: { at: number; crossing: BgpCrossing | null } | null
}

/**
 * Somewhere the prefix is looked at from: this server, on your own network,
 * or one of your probe agents, each on its own network.
 */
export interface BgpVantage {
  /** `server`, or the probe agent's id. */
  id: string
  name: string
  kind: 'server' | 'probe-agent'
  /** Its network's AS numbers: set by you for this server, or found from its traces. */
  asns: number[]
  /** Whether the network was found from its traces rather than set. */
  found: boolean
  /** Its network's sessions with RIS collectors, and the route each has. */
  routes: BgpPeerRoute[]
  traces: BgpHomeTrace[]
  /** Why it cannot be traced from now, such as a probe agent offline. */
  unavailable: string | null
}

/** How your own networks reach the prefix, from each vantage point. */
export interface BgpHome {
  /** The AS numbers set for this server's network. */
  asns: number[]
  vantages: BgpVantage[]
  /** Every network of yours, and whose it is: "This server", or a probe agent's name. For marking yours across the page. */
  mine: Record<number, string>
  /** Whether the exchanges' peering LANs could be read from PeeringDB. */
  exchangesKnown: boolean
}

export interface BgpPrefixDetail extends BgpPrefixSummary {
  peers: BgpPeerRoute[]
  events: BgpEvent[]
  activity: BgpActivity[]
  activitySliceMs: number
  /** The latest updates, newest first: what each peer announced or withdrew. */
  updates: BgpUpdate[]
  asNames: Record<number, string>
  connection: BgpConnection
  home: BgpHome
  /** What the exchanges' own route collectors have for it; null until first read. */
  exchanges: BgpExchangeLook | null
}

/** A member's route to the prefix at an exchange, as the exchange's route collector has it. */
export interface BgpExchangeRoute {
  /** The member that offers it there: the first network in the path. */
  peerAsn: number
  /** The member's address on the exchange. */
  gateway: string
  prefix: string
  path: number[]
  /** The collector's best route for the prefix there. */
  best: boolean
  since: number | null
}

/** One exchange's route collector, and what its members offer for the prefix. */
export interface BgpExchangeView {
  /** JINX, CINX. */
  exchange: string
  city: string | null
  /** The looking glass it was read from: INX-ZA. */
  source: string
  /** Whether the collector had its routes in; when not, an absence says nothing. */
  ready: boolean
  routes: BgpExchangeRoute[]
}

/** The exchanges' route collectors, as last read for a prefix. */
export interface BgpExchangeLook {
  at: number
  views: BgpExchangeView[]
  /** Why a looking glass could not be read, if one could not. */
  error: string | null
}
