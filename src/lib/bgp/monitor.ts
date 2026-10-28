import type {
  BgpConnection,
  BgpExchangeLook,
  BgpOverview,
  BgpPeerRoute,
  BgpPrefix,
  BgpPrefixDetail,
  BgpPrefixSummary,
  BgpRegion,
  BgpRoute,
  BgpState,
  BgpStatus,
  BgpUpdate,
} from '@/types/bgp'
import { assess, effectiveRoutes, peerKey, takeBaseline } from './assess'
import { collectorInfo, collectorName, peerPlace, type Place } from './collectors'
import { agentChoices, homeCarriers, homeChanges, homeView, traceInto } from './home'
import { learn } from './learn'
import { LOOK_EVERY_MS, lookAtExchanges, offExchanges, originPresent } from './looking-glass'
import { flattenPath } from './path'
import { prefixWithin } from './prefix'
import { asCountry, asName, currentRoutes, resolveResource } from './ripestat'
import { RisLive, type RisMessage } from './ris-live'
import {
  addBgpPrefix,
  bgpActivity,
  deleteBgpPrefix,
  findBgpPrefix,
  getHomeAsns,
  isBgpEnabled,
  knownAsCountries,
  knownAsNames,
  listBgpEvents,
  listBgpPrefixes,
  listBgpUpdates,
  pruneBgp,
  recordBgpEvent,
  recordBgpUpdates,
  saveNetwork,
  setBgpEnabled,
  setExcludedAgents,
  setHomeAsns,
  updateBgpPrefix,
  EVENTS_KEPT_MS,
  type BgpUpdateRow,
} from './store'

/**
 * BGP monitoring as it runs: every watched prefix's routes, one per collector
 * peer, kept in memory and up to date from RIS Live, and judged again after
 * every change.
 *
 * The routes are read afresh from RIPEstat when monitoring starts, each time
 * the stream reconnects (it says nothing about what passed while it was
 * away), and every half hour besides, in case an update was missed.
 *
 * What is normal for each is taken from its first routes, and from then on
 * learned from how it is carried (see learn.ts).
 */

/** Asked to watch a prefix that is watched already: a 409, not a mistake in what was given. */
export class AlreadyWatchedError extends Error {}

const RESYNC_EVERY_MS = 30 * 60 * 1000
/** After RIPEstat fails to answer, how long before a prefix's routes are asked for again, rather than waiting for the next re-read. */
const RESYNC_RETRY_MS = 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000
/** Updates come in bursts; a prefix is judged once a burst has passed. */
const SETTLE_MS = 1_500
const ACTIVITY_HOURS = 24
const ACTIVITY_SLICE_MS = 15 * 60 * 1000
/**
 * The updates a prefix's page lists: the newest of the day. Enough for every
 * update of all but a busy day, so the bars are counted from the same updates
 * the list shows, and narrow with it.
 */
const UPDATES_LISTED = 2000
/** The most of a prefix's announced prefixes asked about at the exchanges: Alice is asked once for each. */
const MOST_ASKED_AT_EXCHANGES = 8

interface Watched {
  prefix: BgpPrefix
  /** By collector|peer|announced prefix. */
  routes: Map<string, BgpRoute>
  status: BgpStatus
  /** The state last recorded, so only a change is recorded again. */
  recorded: BgpState | null
  /** What your network's sessions reached it through when last judged; null until first judged. */
  home: Map<string, number | null> | null
  /**
   * Whether its routes have been read from RIPEstat since it started being
   * followed. Until then it has next to none, and judged on them would look
   * withdrawn: it is not judged, and is shown as having its routes read.
   */
  synced: boolean
  /** What the exchanges' own route collectors last had for it (see looking-glass.ts); null until read. */
  exchanges: BgpExchangeLook | null
}

/** Whether every exchange was read, and every collector had its routes in: only then is an absence news. */
function readWell(look: BgpExchangeLook): boolean {
  return !look.error && look.views.length > 0 && look.views.every(view => view.ready)
}

function routeKey(route: Pick<BgpRoute, 'collector' | 'peer' | 'prefix'>): string {
  return `${route.collector}|${route.peer}|${route.prefix}`
}

class BgpMonitor {
  private watched = new Map<string, Watched>()
  private stream: RisLive
  private timers: ReturnType<typeof setInterval>[] = []
  private pending: BgpUpdateRow[] = []
  private dirty = new Set<string>()
  private settle: ReturnType<typeof setTimeout> | null = null
  private running = false
  /** Networks being looked up, and those RIPEstat had nothing on, so they are not asked about again. */
  private looking = new Set<number>()
  /** Prefixes whose routes could not be read and are waiting to be asked for again. */
  private retrying = new Set<string>()
  private unknown = new Set<number>()
  /** The country each network is registered in, where looked up: places the peers of multihop collectors. */
  private countries = new Map<number, string>()
  /** Each peer's network, by collector|peer, so a peer that withdraws stays where it was placed. */
  private peerAsns = new Map<string, number>()
  /** Your own network's AS numbers (see home.ts). */
  private homeAsns: number[] = []
  /**
   * Your networks, and whose each is: this server's, and each probe agent's
   * once found from its traces (see home.ts). Brought up to date whenever a
   * prefix's page is read.
   */
  private mine = new Map<number, string>()

  constructor() {
    this.stream = new RisLive({
      onMessage: message => this.apply(message),
      onOpen: () => void this.resyncAll(),
      onChange: connection => {
        if (connection.state === 'offline' && connection.error) console.warn(`[BGP] RIS Live: ${connection.error}`)
      },
    })
  }

  get connection(): BgpConnection {
    return this.stream.connection
  }

  /** Start, if it is turned on. Safe to call again. */
  async start(): Promise<void> {
    if (this.running || !(await isBgpEnabled())) return
    this.running = true
    console.log('[BGP] Starting BGP monitoring')
    this.countries = await knownAsCountries().catch(() => new Map())
    this.homeAsns = await getHomeAsns().catch(() => [])
    this.know(new Map(this.homeAsns.map(asn => [asn, 'This server'])))
    this.lookUpHome()
    for (const prefix of await listBgpPrefixes()) this.track(prefix)
    // The stream's opening reads every prefix afresh (onOpen).
    this.stream.start([...this.watched.values()].map(each => each.prefix.prefix))
    this.timers.push(setInterval(() => void this.resyncAll(), RESYNC_EVERY_MS))
    this.timers.push(setInterval(() => void pruneBgp().catch(error => console.error('[BGP] Pruning failed:', error)), PRUNE_EVERY_MS))
    this.timers.push(setInterval(() => void this.lookAll(), LOOK_EVERY_MS))
    void pruneBgp().catch(() => {})
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.stream.stop()
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    if (this.settle) clearTimeout(this.settle)
    this.settle = null
    void this.flush()
    this.watched.clear()
    console.log('[BGP] Stopped BGP monitoring')
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await setBgpEnabled(enabled)
    if (enabled) await this.start()
    else this.stop()
  }

  /** Set your network's AS numbers. Its routes are followed from the next judgement on, not compared with before. */
  async setHomeAsns(asns: readonly number[]): Promise<number[]> {
    await setHomeAsns(asns)
    this.homeAsns = await getHomeAsns()
    this.know(new Map(this.homeAsns.map(asn => [asn, 'This server'])))
    this.lookUpHome()
    return this.homeAsns
  }

  /** Choose which probe agents Routing uses: all but these. Their routes are followed afresh, as with a changed network. */
  async setExcludedAgents(ids: readonly string[]): Promise<void> {
    await setExcludedAgents(ids)
    for (const watched of this.watched.values()) watched.home = null
  }

  /**
   * Take in your networks as they now are. When they change, your routes are
   * followed afresh from the next judgement, not compared with routes that
   * were not yours a moment ago.
   */
  private know(mine: Map<number, string>): void {
    const same = mine.size === this.mine.size && [...mine].every(([asn, whose]) => this.mine.get(asn) === whose)
    if (same) return
    this.mine = mine
    for (const watched of this.watched.values()) watched.home = null
  }

  /** Trace into the prefix from every vantage point now. Null when it is not being followed. */
  async traceNow(id: string): Promise<number | null> {
    const watched = this.watched.get(id)
    if (!watched) return null
    return traceInto(id, watched.prefix.prefix, watched.prefix.address, { force: true })
  }

  /** Trace into the prefix in the background, as home.ts says when. */
  private traceLater(watched: Watched, options: { staleOnly?: boolean } = {}): void {
    void traceInto(watched.prefix.id, watched.prefix.prefix, watched.prefix.address, options).catch(error =>
      console.warn(`[BGP] Could not trace into ${watched.prefix.prefix}:`, error instanceof Error ? error.message : error)
    )
  }

  /** Where a peer sees from: see collectors.ts. */
  private place(key: string): Place {
    const [collector] = key.split('|')
    return peerPlace(collector, this.peerAsns.get(key) ?? 0, asn => this.countries.get(asn))
  }

  private regionOf = (key: string): BgpRegion => this.place(key).region

  private remember(routes: Iterable<Pick<BgpRoute, 'collector' | 'peer' | 'peerAsn'>>): void {
    for (const route of routes) if (route.peerAsn > 0) this.peerAsns.set(peerKey(route), route.peerAsn)
  }

  /** Follow a prefix: with the routes just read for it, or none yet, to be read (see `synced`). */
  private track(prefix: BgpPrefix, routes?: BgpRoute[]): Watched {
    const read = routes ?? []
    this.remember(read)
    const watched: Watched = {
      prefix,
      routes: new Map(read.map(route => [routeKey(route), route])),
      status: assess(prefix, read, this.regionOf),
      recorded: null,
      home: null,
      synced: routes !== undefined,
      exchanges: null,
    }
    this.watched.set(prefix.id, watched)
    return watched
  }

  // ─── Keeping the routes ─────────────────────────────────────────────────

  private async resync(watched: Watched): Promise<void> {
    try {
      const routes = await currentRoutes(watched.prefix.prefix)
      // Watching may have stopped, or the prefix gone, while RIPEstat answered.
      if (this.watched.get(watched.prefix.id) !== watched) return
      watched.routes = new Map(routes.map(route => [routeKey(route), route]))
      watched.synced = true
      this.remember(routes)
      await this.takeFirstNormal(watched, routes)
      await this.recordDirectPeers(watched, routes)
      if (!watched.exchanges) await this.look(watched).catch(() => {})
      await this.judge(watched)
      this.lookUp(routes)
      this.traceLater(watched, { staleOnly: true })
    } catch (error) {
      console.warn(`[BGP] Could not read the routes to ${watched.prefix.prefix}:`, error instanceof Error ? error.message : error)
      this.resyncLater(watched)
    }
  }

  /** Ask again soon, until RIPEstat answers: the names, countries and traces all wait on these routes. */
  private resyncLater(watched: Watched): void {
    if (this.retrying.has(watched.prefix.id)) return
    this.retrying.add(watched.prefix.id)
    const timer = setTimeout(() => {
      this.retrying.delete(watched.prefix.id)
      if (this.running && this.watched.get(watched.prefix.id) === watched && !watched.synced) void this.resync(watched)
    }, RESYNC_RETRY_MS)
    timer.unref?.()
  }

  /**
   * Normal is how it is carried when first read: a prefix just added, or one
   * no collector saw when it was. With no routes at all there is none to take.
   * Where the origin offers it at the exchanges is added when they are read (see look).
   */
  private async takeFirstNormal(watched: Watched, routes: BgpRoute[]): Promise<void> {
    if (watched.prefix.baseline || routes.length === 0) return
    const baseline = takeBaseline(routes, watched.prefix.prefix, watched.prefix.address, Date.now())
    await updateBgpPrefix(watched.prefix.id, { baseline })
    watched.prefix = { ...watched.prefix, baseline }
  }

  /**
   * A normal taken before the peers that reached it directly were recorded
   * gets them from the first routes read: without them a move off the
   * exchanges could not be seen.
   */
  private async recordDirectPeers(watched: Watched, routes: BgpRoute[]): Promise<void> {
    const baseline = watched.prefix.baseline
    if (!baseline || baseline.directPeers || routes.length === 0) return
    const { directPeers } = takeBaseline(routes, watched.prefix.prefix, watched.prefix.address, Date.now())
    const completed = { ...baseline, directPeers }
    await updateBgpPrefix(watched.prefix.id, { baseline: completed })
    watched.prefix = { ...watched.prefix, baseline: completed }
  }

  private async resyncAll(): Promise<void> {
    for (const watched of [...this.watched.values()]) await this.resync(watched)
  }

  /**
   * Read what the exchanges' own collectors have for it: the prefix and the
   * more-specifics RIS has seen announced, as Alice matches each exactly. A
   * normal taken before they were read gets the exchanges the origin offered
   * it at from the first good read, as with the direct peers.
   */
  private async look(watched: Watched): Promise<void> {
    const prefix = watched.prefix.prefix
    const asked = [prefix, ...new Set([...watched.routes.values()].map(route => route.prefix))]
      .filter((each, index, all) => all.indexOf(each) === index && prefixWithin(each, prefix))
      .slice(0, MOST_ASKED_AT_EXCHANGES)
    const look = await lookAtExchanges(asked)
    if (this.watched.get(watched.prefix.id) !== watched) return
    watched.exchanges = look
    if (look.error) console.warn(`[BGP] ${prefix}: ${look.error}`)
    const baseline = watched.prefix.baseline
    if (baseline && !baseline.exchanges && readWell(look)) {
      const completed = { ...baseline, exchanges: originPresent(look, baseline.origins) }
      await updateBgpPrefix(watched.prefix.id, { baseline: completed }).catch(() => {})
      watched.prefix = { ...watched.prefix, baseline: completed }
    }
    this.lookUp(look.views.flatMap(view => view.routes.map(route => ({ collector: '', path: route.path }))))
  }

  private async lookAll(): Promise<void> {
    for (const watched of [...this.watched.values()]) {
      if (!watched.synced) continue
      await this.look(watched).catch(error => console.warn(`[BGP] Could not read the exchanges for ${watched.prefix.prefix}:`, error))
      await this.judge(watched)
    }
  }

  /** The exchanges it has gone off since normal was taken, by their own collectors. */
  private offExchanges(watched: Watched): string[] {
    const { baseline } = watched.prefix
    const look = watched.exchanges
    if (!baseline?.exchanges || !look) return []
    return offExchanges(baseline.exchanges, look, baseline.origins)
  }

  private apply(message: RisMessage): void {
    if (message.type !== 'UPDATE') return
    const collector = collectorName(message.host)
    const at = Math.round(message.timestamp * 1000)
    const path = message.path ? flattenPath(message.path) : []
    const peerAsn = Number(message.peer_asn)

    const touch = (prefix: string, kind: 'announce' | 'withdraw') => {
      for (const watched of this.watched.values()) {
        if (!prefixWithin(prefix, watched.prefix.prefix)) continue
        const key = routeKey({ collector, peer: message.peer, prefix })
        const previousPath = watched.routes.get(key)?.path ?? null
        if (kind === 'announce') {
          watched.routes.set(key, { collector, peer: message.peer, peerAsn, prefix, path, since: at })
          if (peerAsn > 0) this.peerAsns.set(peerKey({ collector, peer: message.peer }), peerAsn)
        } else if (!watched.routes.delete(key)) {
          // A withdrawal of a route it never had says nothing new.
          continue
        }
        this.pending.push({
          prefixId: watched.prefix.id,
          at,
          collector,
          peer: message.peer,
          prefix,
          kind,
          path: kind === 'announce' ? path : null,
          previousPath,
        })
        this.dirty.add(watched.prefix.id)
      }
    }
    for (const announcement of message.announcements ?? []) {
      for (const prefix of announcement.prefixes) touch(prefix, 'announce')
    }
    for (const prefix of message.withdrawals ?? []) touch(prefix, 'withdraw')

    if (this.dirty.size > 0 && !this.settle) {
      this.settle = setTimeout(() => {
        this.settle = null
        void this.flush()
      }, SETTLE_MS)
    }
  }

  private async flush(): Promise<void> {
    const updates = this.pending
    const dirty = [...this.dirty]
    this.pending = []
    this.dirty.clear()
    try {
      await recordBgpUpdates(updates)
    } catch (error) {
      console.error('[BGP] Could not record updates:', error)
    }
    for (const id of dirty) {
      const watched = this.watched.get(id)
      if (watched) await this.judge(watched)
    }
    this.lookUp(updates.flatMap(update => (update.path ? [{ collector: update.collector, path: update.path }] : [])))
  }

  /** Judge the prefix again, and note it if how it stands has changed. */
  /**
   * Judge the prefix again, and note it if how it stands has changed, or the
   * route your own network has to it. Either is when the path your traffic
   * takes is worth tracing again.
   */
  private async judge(watched: Watched): Promise<void> {
    if (!watched.synced) return
    const routes = [...watched.routes.values()]
    await this.learnNormal(watched, routes)
    watched.status = assess(watched.prefix, routes, this.regionOf, this.offExchanges(watched))
    const prefix = watched.prefix.prefix

    const home = homeCarriers(effectiveRoutes(routes, prefix, watched.prefix.address).values(), this.mine)
    const moved = watched.home ? homeChanges(watched.home, home, this.mine) : []
    watched.home = home
    if (moved.length > 0) {
      await recordBgpEvent(watched.prefix.id, Date.now(), watched.status.state, moved, 'home').catch(error =>
        console.error('[BGP] Could not record a change:', error)
      )
      console.warn(`[BGP] ${prefix}: ${moved.join('; ')}`)
      this.traceLater(watched)
    }

    if (watched.recorded === null) {
      const [latest] = await listBgpEvents(watched.prefix.id, 0)
      watched.recorded = latest?.state ?? null
    }
    if (watched.status.state === watched.recorded) return
    watched.recorded = watched.status.state
    try {
      await recordBgpEvent(watched.prefix.id, Date.now(), watched.status.state, watched.status.reasons)
    } catch (error) {
      console.error('[BGP] Could not record a change:', error)
    }
    if (watched.status.state !== 'normal' && watched.status.state !== 'learning') {
      console.warn(`[BGP] ${prefix} is now ${watched.status.state}: ${watched.status.reasons.join('; ')}`)
    }
    this.traceLater(watched)
  }

  /**
   * Bring what is normal up to date with how it is carried now (see
   * learn.ts), noting on its timeline anything learned or forgotten. Not
   * while it looks hijacked or withdrawn: that is not a way of carrying it to
   * learn from.
   */
  private async learnNormal(watched: Watched, routes: BgpRoute[]): Promise<void> {
    const baseline = watched.prefix.baseline
    if (!baseline || routes.length === 0 || watched.status.state === 'hijack' || watched.status.state === 'withdrawn') return
    const at = Date.now()
    const now = takeBaseline(routes, watched.prefix.prefix, watched.prefix.address, at)
    const look = watched.exchanges
    const carried = { ...now, directPeers: now.directPeers ?? [], exchanges: look && readWell(look) ? originPresent(look, baseline.origins) : undefined }
    const { baseline: next, changed, reasons } = learn(baseline, carried, at)
    if (!changed) return
    watched.prefix = { ...watched.prefix, baseline: next }
    await updateBgpPrefix(watched.prefix.id, { baseline: next }).catch(error => console.error('[BGP] Could not save what is normal:', error))
    if (reasons.length === 0) return
    console.log(`[BGP] ${watched.prefix.prefix}: ${reasons.join('; ')}`)
    await recordBgpEvent(watched.prefix.id, at, watched.status.state, reasons, 'learned').catch(error => console.error('[BGP] Could not record a change:', error))
  }

  // ─── Networks ───────────────────────────────────────────────────────────

  /** Your own network's name too: it may be in no path, so nothing else would ask for it. */
  private lookUpHome(): void {
    this.lookUp(this.homeAsns.map(asn => ({ collector: '', path: [asn] })))
  }

  /**
   * Look up, in the background and a few at a time, the names of the networks
   * in these paths, and the countries of the peers of multihop collectors.
   * Once new countries are in, every prefix is judged again, as some of its
   * peers may now be placed in other regions.
   */
  private lookUp(routes: Pick<BgpRoute, 'collector' | 'path'>[], placing: readonly number[] = []): void {
    const wanted = new Map<number, { name: boolean; country: boolean }>()
    for (const route of routes) {
      for (const asn of route.path) if (!wanted.has(asn)) wanted.set(asn, { name: true, country: false })
      const peer = route.path[0]
      if (peer !== undefined && collectorInfo(route.collector).multihop && !this.countries.has(peer)) wanted.get(peer)!.country = true
    }
    // Your networks, to place your vantage points.
    for (const asn of placing) {
      if (this.countries.has(asn)) continue
      wanted.set(asn, { name: wanted.get(asn)?.name ?? true, country: true })
    }
    void (async () => {
      const named = await knownAsNames([...wanted.keys()])
      const work = [...wanted]
        .map(([asn, want]) => ({ asn, name: want.name && !named.has(asn), country: want.country }))
        .filter(each => (each.name || each.country) && !this.looking.has(each.asn) && !this.unknown.has(each.asn))
      for (const each of work) this.looking.add(each.asn)
      let placed = false
      const worker = async () => {
        for (let each = work.shift(); each !== undefined; each = work.shift()) {
          try {
            // RIPEstat failing to answer is not its having nothing: only the latter is remembered as unknown.
            let failed = false
            const [name, country] = await Promise.all([
              each.name ? asName(each.asn).catch(() => { failed = true; return null }) : null,
              each.country ? asCountry(each.asn).catch(() => { failed = true; return null }) : null,
            ])
            if (name || country) await saveNetwork(each.asn, { name, country })
            if (country) {
              this.countries.set(each.asn, country)
              placed = true
            }
            if (!name && !country && !failed) this.unknown.add(each.asn)
          } catch {
            // Saving it failed, not the lookup: asked about again at the next read.
          } finally {
            this.looking.delete(each.asn)
          }
        }
      }
      await Promise.all([worker(), worker(), worker()])
      if (placed) for (const watched of [...this.watched.values()]) await this.judge(watched)
    })().catch(() => {})
  }

  // ─── What the pages ask ─────────────────────────────────────────────────

  private summary(watched: Watched): BgpPrefixSummary {
    if (!watched.synced) {
      return { ...watched.prefix, status: { ...watched.status, state: 'learning', reasons: ['Reading its routes from RIPEstat'] } }
    }
    return { ...watched.prefix, status: watched.status }
  }

  async overview(): Promise<BgpOverview> {
    const enabled = await isBgpEnabled()
    // Turned on in another process, or before this one started: catch up.
    if (enabled && !this.running) await this.start()
    // Listed even while it is off, judged against no routes, so turning it on shows what is there.
    const prefixes = this.running
      ? [...this.watched.values()].map(each => this.summary(each))
      : (await listBgpPrefixes()).map(prefix => ({ ...prefix, status: assess(prefix, []) }))
    const homeAsns = await getHomeAsns()
    const asns = [
      ...prefixes.flatMap(each => [...each.status.upstreams.map(up => up.asn), ...each.status.origins, ...(each.baseline?.origins ?? [])]),
      ...homeAsns,
    ]
    return {
      enabled,
      connection: this.connection,
      prefixes,
      asNames: Object.fromEntries(await knownAsNames(asns)),
      homeAsns,
      agents: await agentChoices(),
    }
  }

  async detail(id: string): Promise<BgpPrefixDetail | null> {
    const watched = this.watched.get(id)
    if (!watched) return null
    const routes = [...watched.routes.values()]
    const counted = effectiveRoutes(routes, watched.prefix.prefix, watched.prefix.address)

    const peers: BgpPeerRoute[] = []
    const listed = new Set<string>()
    const listing = (collector: string, peer: string, peerAsn: number, route: BgpRoute | null, effective: boolean): BgpPeerRoute => ({
      collector,
      location: collectorInfo(collector).location,
      ...this.place(`${collector}|${peer}`),
      peer,
      peerAsn,
      route,
      effective,
    })
    for (const [key, route] of counted) {
      peers.push(listing(route.collector, route.peer, route.peerAsn, route, true))
      listed.add(key)
    }
    // A peer that has only a route the address is not in still sees the prefix.
    for (const route of routes) {
      const key = peerKey(route)
      if (listed.has(key)) continue
      peers.push(listing(route.collector, route.peer, route.peerAsn, route, false))
      listed.add(key)
    }
    for (const key of watched.prefix.baseline?.peers ?? []) {
      if (listed.has(key)) continue
      const [collector, peer] = key.split('|')
      peers.push(listing(collector, peer, this.peerAsns.get(key) ?? 0, null, false))
    }
    peers.sort((a, b) => a.region.localeCompare(b.region) || a.collector.localeCompare(b.collector) || a.peer.localeCompare(b.peer))

    const now = Date.now()
    const start = Math.floor((now - ACTIVITY_HOURS * 3600_000) / ACTIVITY_SLICE_MS) * ACTIVITY_SLICE_MS
    const updates: BgpUpdate[] = (await listBgpUpdates(id, start, UPDATES_LISTED)).map(update => ({
      id: update.id,
      at: update.at,
      collector: update.collector,
      location: collectorInfo(update.collector).location,
      peer: update.peer,
      peerAsn: (update.path ?? update.previousPath)?.[0] ?? this.peerAsns.get(`${update.collector}|${update.peer}`) ?? 0,
      prefix: update.prefix,
      kind: update.kind,
      path: update.path,
      previousPath: update.previousPath,
    }))
    const home = await homeView(id, watched.prefix.prefix, watched.prefix.address, this.homeAsns, peers, asn => this.countries.get(asn))
    this.know(new Map(Object.entries(home.mine).map(([asn, whose]) => [Number(asn), whose])))
    // The networks your traces passed through, and either side of where one
    // probably crossed an exchange: named like the rest, and looked up if not
    // yet; and where each of your networks is, to place it on the page.
    const traced = home.vantages.flatMap(vantage => [
      ...vantage.tracedPath,
      ...vantage.traces.flatMap(trace => [...(trace.likely ? [trace.likely.from, trace.likely.to] : []), ...trace.hops.flatMap(hop => (hop.member ? [hop.member] : []))]),
    ])
    if (traced.length > 0) this.lookUp([{ collector: '', path: traced }], home.vantages.flatMap(vantage => vantage.asns))
    const asns = [
      ...new Set([
        ...routes.flatMap(route => route.path),
        ...peers.map(each => each.peerAsn),
        ...updates.flatMap(update => [...(update.path ?? []), ...(update.previousPath ?? [])]),
        ...Object.keys(home.mine).map(Number),
        ...traced,
        ...home.vantages.flatMap(vantage => vantage.tracedPath),
        ...(watched.exchanges?.views.flatMap(view => view.routes.flatMap(route => route.path)) ?? []),
      ]),
    ]
    return {
      ...this.summary(watched),
      peers,
      events: await listBgpEvents(id, now - EVENTS_KEPT_MS),
      activity: await bgpActivity(id, start, ACTIVITY_SLICE_MS, now),
      activitySliceMs: ACTIVITY_SLICE_MS,
      updates,
      asNames: Object.fromEntries(await knownAsNames(asns)),
      connection: this.connection,
      home,
      exchanges: watched.exchanges,
    }
  }

  // ─── Changes ────────────────────────────────────────────────────────────

  /**
   * Watch the prefix that holds an address, or a prefix as given. It is saved
   * at once and its routes read in the background: RIPEstat can take most of
   * a minute over every peer's route to a prefix, too long to keep the dialog
   * waiting, and a timeout then would lose the prefix. Until they are read it
   * is "learning", and normal is taken from the first routes read (see resync).
   */
  async add(input: string, label: string | null): Promise<BgpPrefixSummary> {
    const resolved = await resolveResource(input)
    if (await findBgpPrefix(resolved.prefix)) throw new AlreadyWatchedError(`${resolved.prefix} is already being watched`)
    const prefix = await addBgpPrefix({ prefix: resolved.prefix, label, address: resolved.address, baseline: null })
    if (this.running) {
      const watched = this.track(prefix)
      this.stream.subscribe(prefix.prefix)
      void this.resync(watched)
      return this.summary(watched)
    }
    return { ...prefix, status: assess(prefix, []) }
  }

  async remove(id: string): Promise<boolean> {
    const watched = this.watched.get(id)
    if (watched) {
      this.watched.delete(id)
      // Another prefix may cover the same space: only stop the stream for it if none does.
      if (![...this.watched.values()].some(each => each.prefix.prefix === watched.prefix.prefix)) {
        this.stream.unsubscribe(watched.prefix.prefix)
      }
    }
    return deleteBgpPrefix(id)
  }

  async relabel(id: string, label: string | null): Promise<boolean> {
    const changed = await updateBgpPrefix(id, { label })
    const watched = this.watched.get(id)
    if (watched) watched.prefix = { ...watched.prefix, label }
    return changed
  }

  /**
   * Take how it is carried now as normal at once, rather than learning it
   * over a day: for a new network announcing it, which is never learned.
   */
  async acceptAsNormal(id: string): Promise<BgpPrefixSummary | null> {
    const watched = this.watched.get(id)
    if (!watched) return null
    const routes = [...watched.routes.values()]
    if (routes.length === 0) throw new Error('No collector sees it now, so there is nothing to take as normal')
    const look = watched.exchanges
    const taken = takeBaseline(routes, watched.prefix.prefix, watched.prefix.address, Date.now())
    // Where the origin offers it at the exchanges now is normal too, if they were read well; else from the next good read.
    const baseline = look && readWell(look) ? { ...taken, exchanges: originPresent(look, taken.origins) } : taken
    await updateBgpPrefix(id, { baseline })
    watched.prefix = { ...watched.prefix, baseline }
    await recordBgpEvent(id, Date.now(), watched.status.state, ['Taken as normal as it is carried now, including the networks announcing it'], 'learned').catch(() => {})
    await this.judge(watched)
    return this.summary(watched)
  }
}

/**
 * One monitor for the server, on globalThis: route handlers are bundled
 * separately, and a module-level one would be a monitor each.
 */
const KEY = Symbol.for('clearping.bgp')

export function getBgpMonitor(): BgpMonitor {
  const store = globalThis as typeof globalThis & { [KEY]?: BgpMonitor }
  store[KEY] ??= new BgpMonitor()
  return store[KEY]
}
