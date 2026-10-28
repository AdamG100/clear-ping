import { randomUUID } from 'crypto'
import type sqlite3 from 'sqlite3'
import type { BgpActivity, BgpBaseline, BgpEvent, BgpPrefix, BgpState } from '@/types/bgp'
import type { TracerouteHop } from '@/types/probe'
import { getDatabase } from '../db/database'

/**
 * BGP monitoring as it is kept: whether it is on, the prefixes watched and
 * what was normal for each, and a short record of what happened to them.
 *
 * Kept briefly, as nothing here is history worth having for long: the updates
 * that arrived for two days, for the activity strip, and the changes in how a
 * prefix stood for two weeks, for its timeline.
 */

type Database = sqlite3.Database

export const UPDATES_KEPT_MS = 2 * 24 * 60 * 60 * 1000
export const EVENTS_KEPT_MS = 14 * 24 * 60 * 60 * 1000

const ENABLED_KEY = 'bgp.enabled'
const HOME_KEY = 'bgp.home_asns'
const EXCLUDED_AGENTS_KEY = 'bgp.excluded_agents'
const EXCHANGES_KEY = 'bgp.exchanges'

function run(database: Database, sql: string, params: unknown[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function (error) {
      if (error) reject(error)
      else resolve(this.changes)
    })
  })
}

function all<T>(database: Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows) => (error ? reject(error) : resolve((rows ?? []) as T[])))
  })
}

// ─── On or off ──────────────────────────────────────────────────────────────

export async function isBgpEnabled(): Promise<boolean> {
  const [row] = await all<{ value: string }>(await getDatabase(), 'SELECT value FROM settings WHERE key = ?', [ENABLED_KEY])
  return row?.value === 'true'
}

export async function setBgpEnabled(enabled: boolean): Promise<void> {
  await run(
    await getDatabase(),
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [ENABLED_KEY, String(enabled)]
  )
}

// ─── Your network ───────────────────────────────────────────────────────────

/** Your own network's AS numbers: whose routes and traffic "From your network" shows. */
export async function getHomeAsns(): Promise<number[]> {
  const [row] = await all<{ value: string }>(await getDatabase(), 'SELECT value FROM settings WHERE key = ?', [HOME_KEY])
  try {
    const parsed: unknown = row ? JSON.parse(row.value) : []
    return Array.isArray(parsed) ? parsed.filter((asn): asn is number => Number.isInteger(asn) && asn > 0) : []
  } catch {
    return []
  }
}

export async function setHomeAsns(asns: readonly number[]): Promise<void> {
  await run(
    await getDatabase(),
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [HOME_KEY, JSON.stringify([...new Set(asns)])]
  )
}

/** The probe agents taken out of Routing: every other one is a vantage point, new ones included. */
export async function getExcludedAgents(): Promise<string[]> {
  const [row] = await all<{ value: string }>(await getDatabase(), 'SELECT value FROM settings WHERE key = ?', [EXCLUDED_AGENTS_KEY])
  try {
    const parsed: unknown = row ? JSON.parse(row.value) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export async function setExcludedAgents(ids: readonly string[]): Promise<void> {
  await run(
    await getDatabase(),
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [EXCLUDED_AGENTS_KEY, JSON.stringify([...new Set(ids)])]
  )
}

// ─── Exchanges ──────────────────────────────────────────────────────────────

/** The exchanges' peering LANs as last read from PeeringDB, and when: kept so a restart need not read them again. */
export async function readExchangeCopy<T>(): Promise<{ at: number; lans: T } | null> {
  const [row] = await all<{ value: string }>(await getDatabase(), 'SELECT value FROM settings WHERE key = ?', [EXCHANGES_KEY])
  try {
    return row ? (JSON.parse(row.value) as { at: number; lans: T }) : null
  } catch {
    return null
  }
}

export async function saveExchangeCopy<T>(at: number, lans: T): Promise<void> {
  await run(
    await getDatabase(),
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [EXCHANGES_KEY, JSON.stringify({ at, lans })]
  )
}

// ─── Prefixes ───────────────────────────────────────────────────────────────

interface PrefixRow {
  id: string
  prefix: string
  label: string | null
  address: string | null
  baseline: string | null
  created_at: number
}

function fromRow(row: PrefixRow): BgpPrefix {
  let baseline: BgpBaseline | null = null
  try {
    baseline = row.baseline ? (JSON.parse(row.baseline) as BgpBaseline) : null
  } catch {
    baseline = null
  }
  return { id: row.id, prefix: row.prefix, label: row.label, address: row.address, baseline, createdAt: row.created_at }
}

export async function listBgpPrefixes(): Promise<BgpPrefix[]> {
  const rows = await all<PrefixRow>(await getDatabase(), 'SELECT * FROM bgp_prefixes ORDER BY created_at')
  return rows.map(fromRow)
}

export async function getBgpPrefix(id: string): Promise<BgpPrefix | null> {
  const [row] = await all<PrefixRow>(await getDatabase(), 'SELECT * FROM bgp_prefixes WHERE id = ?', [id])
  return row ? fromRow(row) : null
}

export async function findBgpPrefix(prefix: string): Promise<BgpPrefix | null> {
  const [row] = await all<PrefixRow>(await getDatabase(), 'SELECT * FROM bgp_prefixes WHERE prefix = ?', [prefix])
  return row ? fromRow(row) : null
}

export async function addBgpPrefix(input: { prefix: string; label: string | null; address: string | null; baseline: BgpBaseline | null }): Promise<BgpPrefix> {
  const prefix: BgpPrefix = { id: randomUUID(), ...input, createdAt: Date.now() }
  await run(
    await getDatabase(),
    'INSERT INTO bgp_prefixes (id, prefix, label, address, baseline, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [prefix.id, prefix.prefix, prefix.label, prefix.address, prefix.baseline ? JSON.stringify(prefix.baseline) : null, prefix.createdAt]
  )
  return prefix
}

export async function updateBgpPrefix(id: string, changes: { label?: string | null; baseline?: BgpBaseline }): Promise<boolean> {
  const database = await getDatabase()
  let changed = 0
  if (changes.label !== undefined) changed += await run(database, 'UPDATE bgp_prefixes SET label = ? WHERE id = ?', [changes.label, id])
  if (changes.baseline) changed += await run(database, 'UPDATE bgp_prefixes SET baseline = ? WHERE id = ?', [JSON.stringify(changes.baseline), id])
  return changed > 0
}

export async function deleteBgpPrefix(id: string): Promise<boolean> {
  const database = await getDatabase()
  // Removed by hand as well as by the cascade, for a connection without foreign keys on.
  await run(database, 'DELETE FROM bgp_updates WHERE prefix_id = ?', [id])
  await run(database, 'DELETE FROM bgp_events WHERE prefix_id = ?', [id])
  await run(database, 'DELETE FROM bgp_traces WHERE prefix_id = ?', [id])
  return (await run(database, 'DELETE FROM bgp_prefixes WHERE id = ?', [id])) > 0
}

// ─── What happened ──────────────────────────────────────────────────────────

export interface BgpUpdateRow {
  prefixId: string
  at: number
  collector: string
  peer: string
  prefix: string
  kind: 'announce' | 'withdraw'
  path: number[] | null
  /** The path the peer had for that prefix before this update; null when it had none. */
  previousPath: number[] | null
}

const pathText = (path: readonly number[] | null) => (path ? path.join(' ') : null)
const pathFrom = (text: string | null) => (text ? text.split(' ').map(Number).filter(Number.isFinite) : null)
/**
 * The path before: stored empty when the peer had none, so that it can be
 * told from NULL, an update recorded before the path before was kept.
 */
const previousFrom = (text: string | null) => (text === null ? undefined : pathFrom(text))

/**
 * Several updates at once: they arrive in bursts. A statement of many rows
 * rather than a transaction, which on the one connection everything shares
 * would collide with the prober's own.
 */
export async function recordBgpUpdates(updates: readonly BgpUpdateRow[]): Promise<void> {
  const database = await getDatabase()
  for (let start = 0; start < updates.length; start += 100) {
    const batch = updates.slice(start, start + 100)
    await run(
      database,
      `INSERT INTO bgp_updates (prefix_id, at, collector, peer, prefix, kind, path, previous_path) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      batch.flatMap(update => [
        update.prefixId,
        update.at,
        update.collector,
        update.peer,
        update.prefix,
        update.kind,
        pathText(update.path),
        pathText(update.previousPath) ?? '',
      ])
    )
  }
}

/** The latest updates for a prefix since a time, newest first. */
export async function listBgpUpdates(
  prefixId: string,
  since: number,
  limit = 300
): Promise<(Omit<BgpUpdateRow, 'previousPath'> & { id: number; previousPath: number[] | null | undefined })[]> {
  const rows = await all<{ id: number; at: number; collector: string; peer: string; prefix: string; kind: 'announce' | 'withdraw'; path: string | null; previous_path: string | null }>(
    await getDatabase(),
    'SELECT id, at, collector, peer, prefix, kind, path, previous_path FROM bgp_updates WHERE prefix_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?',
    [prefixId, since, limit]
  )
  return rows.map(row => ({
    id: row.id,
    prefixId,
    at: row.at,
    collector: row.collector,
    peer: row.peer,
    prefix: row.prefix,
    kind: row.kind,
    path: pathFrom(row.path),
    previousPath: previousFrom(row.previous_path),
  }))
}

export async function recordBgpEvent(
  prefixId: string,
  at: number,
  state: BgpState,
  reasons: string[],
  kind: BgpEvent['kind'] = 'state'
): Promise<void> {
  await run(
    await getDatabase(),
    'INSERT INTO bgp_events (prefix_id, at, kind, state, reasons) VALUES (?, ?, ?, ?, ?)',
    [prefixId, at, kind, state, JSON.stringify(reasons)]
  )
}

export async function listBgpEvents(prefixId: string, since: number): Promise<BgpEvent[]> {
  const rows = await all<{ id: number; prefix_id: string; at: number; kind: BgpEvent['kind'] | null; state: BgpState; reasons: string }>(
    await getDatabase(),
    'SELECT * FROM bgp_events WHERE prefix_id = ? AND at >= ? ORDER BY at DESC LIMIT 200',
    [prefixId, since]
  )
  return rows.map(row => {
    let reasons: string[] = []
    try {
      reasons = JSON.parse(row.reasons)
    } catch {
      reasons = []
    }
    return { id: row.id, prefixId: row.prefix_id, at: row.at, kind: row.kind ?? 'state', state: row.state, reasons }
  })
}

/** How many announcements and withdrawals arrived in each slice from `start` to now. */
export async function bgpActivity(prefixId: string, start: number, sliceMs: number, end = Date.now()): Promise<BgpActivity[]> {
  const rows = await all<{ slice: number; kind: 'announce' | 'withdraw'; count: number }>(
    await getDatabase(),
    `SELECT CAST((at - ?) / ? AS INTEGER) AS slice, kind, COUNT(*) AS count
       FROM bgp_updates WHERE prefix_id = ? AND at >= ? AND at < ?
      GROUP BY slice, kind`,
    [start, sliceMs, prefixId, start, end]
  )
  const slices = Math.ceil((end - start) / sliceMs)
  const activity: BgpActivity[] = Array.from({ length: slices }, (_, index) => ({
    start: start + index * sliceMs,
    announcements: 0,
    withdrawals: 0,
  }))
  for (const row of rows) {
    const slice = activity[row.slice]
    if (!slice) continue
    if (row.kind === 'announce') slice.announcements += row.count
    else slice.withdrawals += row.count
  }
  return activity
}

/**
 * The most updates kept for one prefix, newest first: a quiet prefix has tens
 * a day, but one flapping across every collector can have that many an hour,
 * and two days of it would fill the database. About 15 MB at the most.
 */
export const MOST_UPDATES_KEPT = 50_000

/** Forget what is older than it is kept for, and a prefix's updates past the most kept. */
export async function pruneBgp(now = Date.now()): Promise<void> {
  const database = await getDatabase()
  await run(database, 'DELETE FROM bgp_updates WHERE at < ?', [now - UPDATES_KEPT_MS])
  const busy = await all<{ prefix_id: string }>(database, 'SELECT prefix_id FROM bgp_updates GROUP BY prefix_id HAVING COUNT(*) > ?', [MOST_UPDATES_KEPT])
  for (const { prefix_id: id } of busy) {
    await run(
      database,
      'DELETE FROM bgp_updates WHERE prefix_id = ? AND at < (SELECT at FROM bgp_updates WHERE prefix_id = ? ORDER BY at DESC LIMIT 1 OFFSET ?)',
      [id, id, MOST_UPDATES_KEPT - 1]
    )
  }
  await run(database, 'DELETE FROM bgp_events WHERE at < ?', [now - EVENTS_KEPT_MS])
  await run(database, 'DELETE FROM bgp_traces WHERE at < ?', [now - EVENTS_KEPT_MS])
}

// ─── Traces ─────────────────────────────────────────────────────────────────

/** A traceroute Routing took from a vantage point into a prefix (see home.ts). */
export interface BgpTraceRow {
  prefixId: string
  /** `server`, or the probe agent's id. */
  vantage: string
  at: number
  address: string
  reached: boolean
  error: string | null
  hops: TracerouteHop[]
}

export async function recordBgpTrace(trace: BgpTraceRow): Promise<void> {
  await run(
    await getDatabase(),
    'INSERT INTO bgp_traces (prefix_id, vantage, at, address, reached, error, hops) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [trace.prefixId, trace.vantage, trace.at, trace.address, trace.reached ? 1 : 0, trace.error, JSON.stringify(trace.hops)]
  )
}

/** The traces into a prefix, newest first, as many to each vantage point and address as `perPair`. */
export async function listBgpTraces(prefixId: string, perPair = 20): Promise<BgpTraceRow[]> {
  const rows = await all<{ vantage: string; at: number; address: string; reached: number; error: string | null; hops: string }>(
    await getDatabase(),
    `SELECT vantage, at, address, reached, error, hops FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY vantage, address ORDER BY at DESC) AS n FROM bgp_traces WHERE prefix_id = ?
     ) WHERE n <= ? ORDER BY at DESC`,
    [prefixId, perPair]
  )
  return rows.map(row => {
    let hops: TracerouteHop[] = []
    try {
      hops = JSON.parse(row.hops)
    } catch {
      hops = []
    }
    return { prefixId, vantage: row.vantage, at: row.at, address: row.address, reached: row.reached === 1, error: row.error, hops }
  })
}

// ─── Networks ───────────────────────────────────────────────────────────────

/** Names already looked up for these networks. */
export async function knownAsNames(asns: readonly number[]): Promise<Map<number, string>> {
  if (asns.length === 0) return new Map()
  const unique = [...new Set(asns)]
  const rows = await all<{ asn: number; name: string }>(
    await getDatabase(),
    `SELECT asn, name FROM bgp_networks WHERE name IS NOT NULL AND asn IN (${unique.map(() => '?').join(',')})`,
    unique
  )
  return new Map(rows.map(row => [row.asn, row.name]))
}

/** Every country already looked up, by network: few enough to hold in memory. */
export async function knownAsCountries(): Promise<Map<number, string>> {
  const rows = await all<{ asn: number; country: string }>(await getDatabase(), 'SELECT asn, country FROM bgp_networks WHERE country IS NOT NULL')
  return new Map(rows.map(row => [row.asn, row.country]))
}

/** Keep what was found out about a network, leaving what was known before where nothing new was found. */
export async function saveNetwork(asn: number, found: { name: string | null; country: string | null }): Promise<void> {
  await run(
    await getDatabase(),
    `INSERT INTO bgp_networks (asn, name, country, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(asn) DO UPDATE SET name = COALESCE(excluded.name, name), country = COALESCE(excluded.country, country), fetched_at = excluded.fetched_at`,
    [asn, found.name, found.country, Date.now()]
  )
}
