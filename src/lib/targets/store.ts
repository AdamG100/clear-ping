import { isIP } from 'net';
import type { AddressFamily } from '@/types/probe';
import type { ProbeId } from '@/types/probe-agent';
import { getDatabase } from '../db/database';

/**
 * What is kept for each probe of a monitor: when it was last measured from
 * there, and the address each family resolved to. The list of which probes
 * measure a monitor is read and changed with the monitor itself
 * (`getAllTargets`, `setTargetProbes` in db/database.ts).
 */

/** The key a monitor and one of its probes go under. */
export const pairKey = (targetId: string, probe: ProbeId) => `${targetId}|${probe}`;

function run(sql: string, params: unknown[]): Promise<void> {
  return getDatabase().then(
    db =>
      new Promise<void>((resolve, reject) => {
        db.run(sql, params, err => (err ? reject(err) : resolve()));
      })
  );
}

function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return getDatabase().then(
    db =>
      new Promise<T[]>((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve((rows ?? []) as T[])));
      })
  );
}

/** When each probe of each monitor last measured it, by `pairKey`: what the scheduler resumes from. */
export async function getPairTimes(): Promise<Map<string, number>> {
  const rows = await all<{ target_id: string; probe: string; last_probe_at: number }>(
    'SELECT target_id, probe, last_probe_at FROM target_probes WHERE removed_at IS NULL'
  );
  return new Map(rows.map(row => [pairKey(row.target_id, row.probe), row.last_probe_at]));
}

/**
 * Stamp a probe's round of a monitor as taken at `at`, and keep the address it
 * resolved the name to for each family (an address is a family of its own, so
 * the caller says which). The monitor's own last-probe time never moves back:
 * an older image reads it, and it is the newest of its probes'.
 */
export async function recordPairRound(
  targetId: string,
  probe: ProbeId,
  at: number,
  resolved: Array<{ family?: AddressFamily; address: string }> = []
): Promise<void> {
  const [row] = await all<{ resolved: string | null }>(
    'SELECT resolved FROM target_probes WHERE target_id = ? AND probe = ?',
    [targetId, probe]
  );

  let stored: Record<string, string> = {};
  try {
    stored = row?.resolved ? (JSON.parse(row.resolved) as Record<string, string>) : {};
  } catch {
    stored = {};
  }
  for (const { family, address } of resolved) {
    const kind = family ?? isIP(address);
    if (kind === 4 || kind === 6) stored[String(kind)] = address;
  }

  await run(
    `UPDATE target_probes SET last_probe_at = MAX(last_probe_at, ?), resolved = ? WHERE target_id = ? AND probe = ?`,
    [at, Object.keys(stored).length > 0 ? JSON.stringify(stored) : null, targetId, probe]
  );
  await run('UPDATE targets SET last_probe_at = MAX(COALESCE(last_probe_at, 0), ?) WHERE id = ?', [at, targetId]);
}
