import type { Continent, GameRegion } from './catalogue'

/**
 * Valve's relays for a game, from Valve's own list.
 *
 * CS2, Dota 2 and Deadlock connect players through Steam Datagram Relay:
 * Valve's relays in each region, which Valve lists for each game at
 * GetSDRConfig. The list changes as Valve adds and moves relays, so it is read
 * from Valve rather than written down here, and kept for a few hours.
 *
 * Relays answer ICMP ping. Their own UDP ping is a format of Valve's that is
 * not published, so ping is how they are measured.
 */

const SDR_CONFIG = 'https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid='

/** How long a game's list is kept before it is read again. Valve changes it every few weeks. */
const KEEP_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

interface SdrPop {
  desc?: unknown
  /** [longitude, latitude] */
  geo?: unknown
  relays?: unknown
}

/**
 * The continent a place is on, from its longitude and latitude. Rough, but
 * only ever asked about cities with relays in them.
 */
export function continentAt(longitude: number, latitude: number): Continent {
  if (latitude < -10 && (longitude > 110 || longitude < -150)) return 'Oceania'
  if (longitude < -30) return latitude >= 7 ? 'North America' : 'South America'
  // From the Levant to the Gulf. Istanbul, west of it, is Europe; Cairo, south-west, Africa.
  if (longitude >= 34 && longitude <= 63 && latitude >= 12 && latitude <= 42) return 'Middle East'
  if (longitude <= 60) return latitude >= 35 ? 'Europe' : 'Africa'
  return 'Asia'
}

/** "Frankfurt (Germany)" as "Frankfurt, Germany". */
function labelOf(desc: string): string {
  return desc.replace(/\s*\(([^)]+)\)\s*$/, ', $1').trim()
}

/**
 * The regions in Valve's answer: one for each location with relays, pinged at
 * its first relay. Locations without relays (Valve lists partners' too) are
 * left out, as is anything not shaped as expected.
 */
export function readSdrConfig(body: unknown): GameRegion[] {
  const pops = (body as { pops?: unknown } | null)?.pops
  if (!pops || typeof pops !== 'object') throw new Error('Valve\'s answer has no list of relays')

  const regions: GameRegion[] = []
  for (const [code, pop] of Object.entries(pops as Record<string, SdrPop>)) {
    const relays = Array.isArray(pop?.relays) ? (pop.relays as { ipv4?: unknown }[]) : []
    const ipv4 = relays.map(relay => relay?.ipv4).find((value): value is string => typeof value === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(value))
    const geo = Array.isArray(pop.geo) && pop.geo.length === 2 && pop.geo.every(value => typeof value === 'number') ? (pop.geo as [number, number]) : null
    if (!ipv4 || !geo || !/^[a-z0-9]{2,10}$/.test(code)) continue
    regions.push({
      id: code,
      label: typeof pop.desc === 'string' && pop.desc.trim() ? labelOf(pop.desc) : code,
      continent: continentAt(geo[0], geo[1]),
      host: ipv4,
      method: { kind: 'icmp' },
    })
  }
  return regions.sort((a, b) => a.label.localeCompare(b.label))
}

const kept = new Map<number, { at: number; regions: GameRegion[] }>()
const reading = new Map<number, Promise<GameRegion[]>>()

async function fetchRegions(appId: number): Promise<GameRegion[]> {
  const response = await fetch(`${SDR_CONFIG}${appId}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' })
  if (!response.ok) throw new Error(`Valve answered ${response.status}`)
  return readSdrConfig(await response.json())
}

/**
 * A Valve game's regions, read at most once every few hours. When Valve
 * cannot be reached, the last list it gave is used, however old.
 */
export async function valveRegions(appId: number, now = Date.now()): Promise<GameRegion[]> {
  const last = kept.get(appId)
  if (last && now - last.at < KEEP_MS) return last.regions

  let pending = reading.get(appId)
  if (!pending) {
    pending = fetchRegions(appId).finally(() => reading.delete(appId))
    reading.set(appId, pending)
  }
  try {
    const regions = await pending
    kept.set(appId, { at: now, regions })
    return regions
  } catch (error) {
    if (last) return last.regions
    throw error
  }
}
