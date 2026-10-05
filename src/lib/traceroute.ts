import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { lookupService } from 'dns/promises';
import type { ProbeIpVersion, Target, Traceroute, TracerouteHop } from '@/types/probe';
import { getDatabase } from './database';
import { classifyHost, normalizeHost, probeRuns, type AddressFamily } from './host';
import { resolveHost } from './resolve';
import { parseTraceroute, traceReached, tracerouteCommand } from './traceroute-parse';

/**
 * Running traceroutes and keeping them.
 *
 * The chart can show that packets were lost; a traceroute shows where. It is
 * run on request, and automatically at the moment a loss or unreachable alert
 * fires — the route through a failure can only be captured while the failure
 * is happening, and by the time anyone opens the dashboard it has usually
 * cleared.
 */

/** Hard ceiling on one trace. A partial trace is still parsed and kept. */
const TRACE_TIMEOUT_MS = 90_000

type TraceTarget = Pick<Target, 'id' | 'host' | 'ipVersion'>;

interface TracerouteRow {
  id: string;
  target_id: string;
  timestamp: number;
  trigger_source: 'manual' | 'alert';
  address: string;
  hops: string;
  reached: number;
  error_message: string | null;
}

function toTraceroute(row: TracerouteRow): Traceroute {
  let hops: Traceroute['hops'] = [];
  try {
    hops = JSON.parse(row.hops);
  } catch {
    // An unreadable trace is shown as an empty one rather than breaking the list.
  }

  return {
    id: row.id,
    targetId: row.target_id,
    timestamp: new Date(row.timestamp),
    trigger: row.trigger_source,
    address: row.address,
    hops,
    reached: row.reached === 1,
    errorMessage: row.error_message ?? undefined,
  };
}

export async function ensureTracerouteSchema(): Promise<void> {
  const db = await getDatabase();

  for (const sql of [
    `CREATE TABLE IF NOT EXISTS traceroutes (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      trigger_source TEXT NOT NULL,
      address TEXT NOT NULL,
      hops TEXT NOT NULL,
      reached INTEGER NOT NULL,
      error_message TEXT,
      FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
    )`,
    'CREATE INDEX IF NOT EXISTS idx_traceroutes_target_timestamp ON traceroutes(target_id, timestamp DESC)',
  ]) {
    await new Promise<void>((resolve, reject) => {
      db.run(sql, err => (err ? reject(err) : resolve()));
    });
  }
}

/** Spawn the system traceroute and return whatever it printed, complete or not. */
function runCommand(command: string, args: string[]): Promise<{ stdout: string; error?: string }> {
  return new Promise(resolve => {
    execFile(command, args, { timeout: TRACE_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout });
        return;
      }

      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      const reason =
        failure.code === 'ENOENT'
          ? `${command} is not installed on this machine`
          : failure.killed
            ? `Stopped after ${TRACE_TIMEOUT_MS / 1000}s without finishing`
            : (stderr || failure.message).trim().split(/\r?\n/)[0];

      // The hops traced before a timeout are exactly the useful part.
      resolve({ stdout: stdout ?? '', error: reason });
    });
  });
}

/**
 * Trace the route to a target over one address family. Never throws; a
 * failure is recorded in the result.
 */
export async function runTraceroute(
  target: Pick<Target, 'id' | 'host'>,
  trigger: Traceroute['trigger'],
  ipVersion: ProbeIpVersion = 'auto'
): Promise<Traceroute> {
  const base = { id: randomUUID(), targetId: target.id, timestamp: new Date(), trigger };
  const host = normalizeHost(target.host);
  const kind = classifyHost(host);

  if (kind === 'invalid') {
    return { ...base, address: host, hops: [], reached: false, errorMessage: `Invalid host: ${target.host}` };
  }

  let address = host;
  let family: AddressFamily = kind === 'ipv6' ? 6 : 4;

  // Resolved here, as the probes do, so the trace follows the same address
  // family the target is actually monitored over.
  if (kind === 'hostname') {
    const resolved = await resolveHost(host, ipVersion);
    if (!resolved.ok) {
      return { ...base, address: host, hops: [], reached: false, errorMessage: resolved.error };
    }
    address = resolved.address;
    family = resolved.family;
  }

  const { command, args } = tracerouteCommand(address, family);
  const { stdout, error } = await runCommand(command, args);
  const hops = parseTraceroute(stdout);

  return {
    ...base,
    address,
    hops,
    reached: traceReached(hops, address),
    // An error alongside hops means "cut short", which the hops already show.
    errorMessage: hops.length === 0 ? error ?? 'Traceroute produced no output' : undefined,
  };
}

export async function storeTraceroute(trace: Traceroute): Promise<void> {
  const db = await getDatabase();

  await new Promise<void>((resolve, reject) => {
    db.run(
      `INSERT INTO traceroutes (id, target_id, timestamp, trigger_source, address, hops, reached, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trace.id,
        trace.targetId,
        trace.timestamp.getTime(),
        trace.trigger,
        trace.address,
        JSON.stringify(trace.hops),
        trace.reached ? 1 : 0,
        trace.errorMessage ?? null,
      ],
      err => (err ? reject(err) : resolve())
    );
  });
}

export async function getTraceroutes(targetId: string, limit = 10): Promise<Traceroute[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM traceroutes WHERE target_id = ? ORDER BY timestamp DESC LIMIT ?',
      [targetId, Math.min(50, Math.max(1, Math.floor(limit)))],
      (err, rows) => {
        if (err) reject(err);
        else resolve((rows as TracerouteRow[]).map(toTraceroute));
      }
    );
  });
}

/** Delete traces past the retention window. Returns the number removed. */
export async function cleanOldTraceroutes(daysToKeep: number): Promise<number> {
  const db = await getDatabase();
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

  return new Promise<number>((resolve, reject) => {
    db.run('DELETE FROM traceroutes WHERE timestamp < ?', [cutoff], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

/**
 * Reverse lookups go through the operating system (`getnameinfo`), which runs
 * on Node's small shared thread pool — the same one that resolves the names of
 * domain targets. A reverse lookup with no answer can sit there for seconds,
 * so only this many run at once: naming a 20-hop trace must not be able to
 * starve a probe of the thread it needs to resolve its target.
 */
const NAME_LOOKUP_CONCURRENCY = 2;
const NAME_CACHE_MS = 6 * 60 * 60 * 1000;

/** Routers keep their names; looking each one up once is enough for a while. */
const nameCache = new Map<string, { hostname: string | null; at: number }>();

/** A router's name from reverse DNS, or null if it has none. */
async function reverseName(address: string): Promise<string | null> {
  const cached = nameCache.get(address);
  if (cached && Date.now() - cached.at < NAME_CACHE_MS) return cached.hostname;

  let hostname: string | null = null;

  // Link-local addresses are never in DNS, and asking only wastes a timeout.
  if (!/^fe80:/i.test(address)) {
    try {
      const result = await lookupService(address.split('%')[0], 0);
      // With no PTR record the address comes back unchanged.
      hostname = result.hostname && result.hostname !== address ? result.hostname : null;
    } catch {
      hostname = null;
    }
  }

  nameCache.set(address, { hostname, at: Date.now() });
  return hostname;
}

async function updateTracerouteHops(id: string, hops: TracerouteHop[]): Promise<void> {
  const db = await getDatabase();

  await new Promise<void>((resolve, reject) => {
    db.run('UPDATE traceroutes SET hops = ? WHERE id = ?', [JSON.stringify(hops), id], err =>
      err ? reject(err) : resolve()
    );
  });
}

/**
 * Fill in the hops' names after the trace has been stored.
 *
 * Done afterwards, not as part of the trace, because names are the slow part:
 * a single lookup can take longer than the whole trace did. The route is
 * available immediately and the names arrive as they resolve, each one saved
 * as it lands so a reader sees them fill in.
 */
export async function nameHops(trace: Traceroute): Promise<void> {
  const hops: TracerouteHop[] = trace.hops.map(hop =>
    hop.address ? { ...hop } : { ...hop, hostname: null }
  );
  const unnamed = hops.filter(hop => hop.address);
  let next = 0;

  const worker = async () => {
    while (next < unnamed.length) {
      const hop = unnamed[next++];
      hop.hostname = await reverseName(hop.address!);
      await updateTracerouteHops(trace.id, hops);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(NAME_LOOKUP_CONCURRENCY, unnamed.length) }, worker)
  );
}

/**
 * Traces in progress, by target. A second request for a target already being
 * traced joins the first rather than starting another: two traces to the same
 * place at the same moment say the same thing and take twice the packets.
 */
const inFlight = new Map<string, Promise<Traceroute[]>>();

/**
 * Trace a target and record the result.
 *
 * A target probed over both address families is traced over each: IPv4 and
 * IPv6 usually leave by different routes, and it is the route of whichever
 * one is failing that is wanted.
 */
export function traceAndStore(target: TraceTarget, trigger: Traceroute['trigger']): Promise<Traceroute[]> {
  const running = inFlight.get(target.id);
  if (running) return running;

  const trace = (async () => {
    await ensureTracerouteSchema();
    const traces: Traceroute[] = [];

    // One after the other. Run together they would compete for the same
    // replies from the routers they share near this end.
    for (const run of probeRuns(target.host, target.ipVersion)) {
      const result = await runTraceroute(target, trigger, run.ipVersion);
      await storeTraceroute(result);

      // Not awaited: see nameHops.
      void nameHops(result).catch(error =>
        console.error('[Traceroute] Could not look up hop names:', error)
      );

      traces.push(result);
    }

    return traces;
  })().finally(() => inFlight.delete(target.id));

  inFlight.set(target.id, trace);
  return trace;
}
