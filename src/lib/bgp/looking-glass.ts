import type { BgpExchangeLook, BgpExchangeRoute, BgpExchangeView } from '@/types/bgp'
import { prefixLength } from './prefix'

/**
 * Exchanges' own route collectors, read from their Alice looking glasses
 * (alice-lg): what the members of an exchange offer for a prefix there. RIPE
 * RIS has no collector at JINX, CINX or DINX, so this is the only way to see
 * whether the origin still offers a prefix at them itself, or is reached
 * there only through another member's transit.
 *
 * Alice reads its collectors every five minutes and answers from that copy,
 * so asking more often would only get the same answer.
 */

interface LookingGlass {
  name: string
  url: string
}

export const LOOKING_GLASSES: readonly LookingGlass[] = [{ name: 'INX-ZA', url: 'https://lg.inx.net.za' }]

/** Where each exchange is, for those whose collector's name does not say. */
const CITIES: Record<string, string> = {
  JINX: 'Johannesburg',
  CINX: 'Cape Town',
  DINX: 'Durban',
  NMBINX: 'Gqeberha',
}

export const LOOK_EVERY_MS = 5 * 60 * 1000
const TIMEOUT_MS = 30_000
/** Route servers change rarely: their list is read again after this long. */
const SERVERS_KEPT_MS = 24 * 60 * 60 * 1000
const MOST_PAGES = 5

interface RouteServer {
  id: string
  name: string
}

interface AliceRoute {
  network: string
  gateway: string
  routeserver: { id: string }
  bgp: { as_path: number[] }
  age: number
  primary: boolean
}

interface AliceLookup {
  imported: { routes: AliceRoute[]; pagination: { total_pages: number } }
  api: { store_status?: { routes?: { sources?: Record<string, { state?: string; initialized?: boolean }> } } }
}

const servers = new Map<string, { at: number; list: RouteServer[] }>()

async function ask<T>(glass: LookingGlass, path: string): Promise<T> {
  const response = await fetch(`${glass.url}/api/v1/${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'ClearPing (BGP monitoring)' },
  })
  if (!response.ok) throw new Error(`${glass.name}'s looking glass answered ${response.status}`)
  return (await response.json()) as T
}

async function routeServers(glass: LookingGlass): Promise<RouteServer[]> {
  const kept = servers.get(glass.url)
  if (kept && Date.now() - kept.at < SERVERS_KEPT_MS) return kept.list
  const { routeservers } = await ask<{ routeservers: RouteServer[] }>(glass, 'routeservers')
  servers.set(glass.url, { at: Date.now(), list: routeservers })
  return routeservers
}

/** "JINX Route Collector (IPv4)": the exchange, and which addresses it collects. */
export function readServerName(name: string): { exchange: string; version: 4 | 6 | null } {
  const version = /ipv6/i.test(name) ? 6 : /ipv4/i.test(name) ? 4 : null
  return { exchange: name.trim().split(/\s+/)[0] || name, version }
}

/** Every route the glass's collectors have for exactly this prefix: Alice matches no wider or narrower. */
async function lookUp(glass: LookingGlass, prefix: string): Promise<{ routes: AliceRoute[]; ready: Set<string> }> {
  const routes: AliceRoute[] = []
  const ready = new Set<string>()
  for (let page = 0; page < MOST_PAGES; page++) {
    const answer = await ask<AliceLookup>(glass, `lookup/prefix?q=${encodeURIComponent(prefix)}&page=${page}`)
    routes.push(...answer.imported.routes)
    for (const [id, source] of Object.entries(answer.api.store_status?.routes?.sources ?? {})) {
      if (source.initialized || source.state === 'READY') ready.add(id)
    }
    if (page + 1 >= answer.imported.pagination.total_pages) break
  }
  return { routes, ready }
}

/**
 * What every exchange's collector has for these prefixes (the watched one and
 * its more-specifics), one view per exchange, its IPv4 and IPv6 collectors
 * together. A collector with nothing for them is listed too, with no routes:
 * that the prefix is not offered there is worth showing.
 */
export async function lookAtExchanges(prefixes: readonly string[], now = Date.now()): Promise<BgpExchangeLook> {
  const version = prefixes[0]?.includes(':') ? 6 : 4
  const views: BgpExchangeView[] = []
  const problems: string[] = []
  for (const glass of LOOKING_GLASSES) {
    try {
      const collectors = (await routeServers(glass))
        .map(server => ({ ...server, ...readServerName(server.name) }))
        .filter(server => server.version === null || server.version === version)
      const byServer = new Map<string, BgpExchangeRoute[]>()
      const ready = new Set<string>()
      for (const prefix of prefixes) {
        const found = await lookUp(glass, prefix)
        for (const id of found.ready) ready.add(id)
        for (const route of found.routes) {
          const path = route.bgp.as_path ?? []
          if (path.length === 0) continue
          const list = byServer.get(route.routeserver.id) ?? []
          list.push({
            peerAsn: path[0],
            gateway: route.gateway,
            prefix: route.network,
            path,
            best: route.primary,
            // Alice gives a route's age in nanoseconds.
            since: Number.isFinite(route.age) && route.age > 0 ? Math.round(now - route.age / 1e6) : null,
          })
          byServer.set(route.routeserver.id, list)
        }
      }
      const byExchange = new Map<string, BgpExchangeView>()
      for (const server of collectors) {
        const view = byExchange.get(server.exchange) ?? {
          exchange: server.exchange,
          city: CITIES[server.exchange] ?? null,
          source: glass.name,
          ready: true,
          routes: [],
        }
        view.ready &&= ready.has(server.id)
        view.routes.push(...(byServer.get(server.id) ?? []))
        byExchange.set(server.exchange, view)
      }
      views.push(...byExchange.values())
    } catch (error) {
      problems.push(error instanceof Error && error.name !== 'TimeoutError' ? error.message : `${glass.name}'s looking glass did not answer`)
    }
  }
  for (const view of views) {
    view.routes.sort((a, b) => Number(b.best) - Number(a.best) || a.path.length - b.path.length || prefixLength(a.prefix) - prefixLength(b.prefix))
  }
  return { at: now, views, error: problems.length > 0 ? problems.join('; ') : null }
}

/** Whether a route is the origin's own: offered at the exchange by the network that announces it. */
function fromOrigin(route: BgpExchangeRoute, origins: readonly number[]): boolean {
  return origins.includes(route.peerAsn)
}

/** The exchanges where the origin offers it itself. */
export function originPresent(look: BgpExchangeLook, origins: readonly number[]): string[] {
  return look.views.filter(view => view.routes.some(route => fromOrigin(route, origins))).map(view => view.exchange).sort()
}

/**
 * The exchanges the origin offered it at itself when normal was taken, and no
 * longer does, one reason each: the prefix taken off the exchange, which RIS
 * cannot see here. An exchange whose collector is not ready, or that could
 * not be read, says nothing.
 */
export function offExchanges(was: readonly string[], look: BgpExchangeLook, origins: readonly number[]): string[] {
  const reasons: string[] = []
  for (const exchange of was) {
    const view = look.views.find(each => each.exchange === exchange)
    if (!view || !view.ready || view.routes.some(route => fromOrigin(route, origins))) continue
    const through = [...new Set(view.routes.map(route => route.peerAsn))].slice(0, 3).map(asn => `AS${asn}`)
    reasons.push(
      `Off the exchange at ${exchange}: the origin no longer offers it there itself, ${
        through.length > 0 ? `only through ${through.join(', ')}` : 'and no member offers it there'
      }`
    )
  }
  return reasons
}
