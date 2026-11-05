import type { ProbeConfig, ProbeType } from '@/types/probe'

/**
 * Games, and the regions their servers are in, for the Game Server Ping page.
 *
 * Every address here has a source that can be checked: the publisher's own
 * documentation or API, or the cloud provider's. Nothing is guessed, and
 * nothing is copied from other ping-test sites, whose lists say where they
 * came from no more than they say how they were made. Where a game publishes
 * nothing better than the cloud regions it is hosted in, the region says so
 * (`what: 'cloud-region'`), and the page shows it as the region, not as the
 * game's own server.
 *
 * Pure, with no Node imports: the page reads it as well as the server.
 */

export const CONTINENTS = ['Europe', 'North America', 'South America', 'Asia', 'Middle East', 'Africa', 'Oceania'] as const
export type Continent = (typeof CONTINENTS)[number]

/** How a region is asked: as its server is built to answer, since many drop ping. */
export type RegionMethod =
  | { kind: 'icmp' }
  /** A UDP ping beacon, which echoes what it is sent (Amazon GameLift's, on 7770). */
  | { kind: 'udp-echo'; port: number }
  | { kind: 'tcp'; port: number }

/**
 * What the address is, so the page can say what its number means.
 * - `own-servers`: the game's own servers or relays.
 * - `ping-endpoint`: an address the publisher runs for players to measure against.
 * - `cloud-region`: the cloud region the game is hosted in, not a game server.
 */
export type RegionKind = 'own-servers' | 'ping-endpoint' | 'cloud-region'

export interface GameRegion {
  /** Unique within its game, and stable: it is in the address of a test. */
  id: string
  /** Where it is, as a city and country. */
  label: string
  continent: Continent
  host: string
  method: RegionMethod
}

export interface Game {
  id: string
  name: string
  publisher: string
  what: RegionKind
  /** Where the regions came from, to be checked against. */
  sources: string[]
  /** Said under the game's name: what its numbers stand for, where that is not obvious. */
  note?: string
  /**
   * The regions. A Valve game has none here: its relays are read from Valve's
   * own list (`valveAppId`), which changes as Valve adds and moves them.
   */
  regions: GameRegion[]
  valveAppId?: number
}

/** The probe that measures a region, and its settings, as a monitor of it would have. */
export function probeFor(method: RegionMethod): { probeType: ProbeType; probeConfig: ProbeConfig } {
  switch (method.kind) {
    case 'icmp':
      return { probeType: 'ping', probeConfig: {} }
    case 'udp-echo':
      return { probeType: 'game', probeConfig: { port: method.port, gameQuery: 'echo' } }
    case 'tcp':
      return { probeType: 'tcp', probeConfig: { port: method.port } }
  }
}

/** How a region is asked, in a few words for the page. */
export function methodLabel(method: RegionMethod): string {
  switch (method.kind) {
    case 'icmp':
      return 'ICMP ping'
    case 'udp-echo':
      return `UDP echo, port ${method.port}`
    case 'tcp':
      return `TCP connect, port ${method.port}`
  }
}

/** A game as the page lists it: its regions are asked for when it is picked. */
export type GameSummary = Omit<Game, 'regions' | 'valveAppId'> & {
  /** Its regions come from the publisher's own list, read as the page asks, rather than this file. */
  live: boolean
}

export interface RegionReading {
  /** Median of the replies, in milliseconds; null when nothing answered. */
  latency: number | null
  /** Percent of the requests that went unanswered. */
  loss: number
  jitter: number | null
  /** The address a name was resolved to. */
  address?: string
  /** Why nothing came back, when something says. */
  error?: string
}

export const REGION_KIND_LABEL: Record<RegionKind, string> = {
  'own-servers': 'Game servers',
  'ping-endpoint': 'Publisher ping endpoint',
  'cloud-region': 'Cloud region',
}
