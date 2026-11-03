import type { Target } from '@/types/probe';
import type { ProbeId } from '@/types/probe-agent';
import { deleteTargets, getDatabase, withBusyRetry } from '../db/database';
import { measurementKey } from './definition';
import { probeIdsOf } from './probes';

/**
 * Monitors that were set up once for each probe.
 *
 * Before a monitor could have several probes, watching a host from home and
 * from a VPS meant two monitors. Merging puts them together: one monitor, one
 * row in the sidebar, each probe's readings kept apart under it.
 */

export interface DuplicateSet {
  /** What they all measure. */
  key: string;
  monitors: Array<{ id: string; name: string; host: string; group: string; interval: number; probes: ProbeId[] }>;
}

/**
 * Sets of monitors that measure the same thing from different probes: the
 * same address, method and settings, with no probe in more than one. Two that
 * share a probe are left alone, since they are not one monitor split in two.
 */
export function findDuplicateSets(targets: Target[]): DuplicateSet[] {
  const byKey = new Map<string, Target[]>();
  for (const target of targets) {
    const key = measurementKey(target);
    byKey.set(key, [...(byKey.get(key) ?? []), target]);
  }

  const sets: DuplicateSet[] = [];
  for (const [key, group] of byKey) {
    const taken = new Set<ProbeId>();
    const chosen: Target[] = [];
    for (const target of group) {
      const probes = probeIdsOf(target);
      if (probes.some(probe => taken.has(probe))) continue;
      probes.forEach(probe => taken.add(probe));
      chosen.push(target);
    }
    if (chosen.length < 2) continue;
    sets.push({
      key,
      monitors: chosen.map(target => ({
        id: target.id,
        name: target.name,
        host: target.host,
        group: target.group ?? '',
        interval: target.interval,
        probes: probeIdsOf(target),
      })),
    });
  }
  return sets;
}

const BATCH_ROWS = 5000;

function run(sql: string, params: unknown[]): Promise<number> {
  return getDatabase().then(
    database =>
      withBusyRetry(
        () =>
          new Promise<number>((resolve, reject) => {
            database.run(sql, params, function (error) {
              if (error) reject(error);
              else resolve(this.changes);
            });
          })
      )
  );
}

/**
 * Put the `merge` monitors into `keep`: their readings and routes, their
 * probes, and what their alerts know. Each reading keeps the probe tag it has.
 * The merged monitors are deleted. Returns how many readings moved.
 *
 * Alerts that watched a merged monitor now watch `keep`, and so every probe
 * it has: one that watched only a monitor's one probe now watches them all.
 */
export async function mergeMonitors(keep: string, merge: string[]): Promise<number> {
  let moved = 0;
  for (const from of merge.filter(id => id !== keep)) {
    // A few thousand rows at a time, as deleting a monitor does, so a long
    // history does not hold up whatever else writes while it goes.
    for (const table of ['measurements', 'traceroutes']) {
      for (;;) {
        const changed = await run(
          `UPDATE ${table} SET target_id = ? WHERE rowid IN (SELECT rowid FROM ${table} WHERE target_id = ? LIMIT ${BATCH_ROWS})`,
          [keep, from]
        ).catch(error => {
          // No routes table yet is no routes to move.
          if (table === 'traceroutes' && /no such table/i.test(String(error))) return 0;
          throw error;
        });
        if (table === 'measurements') moved += changed;
        if (changed === 0) break;
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    await run(
      `INSERT OR IGNORE INTO target_probes (target_id, probe, position, last_probe_at, resolved, added_at, removed_at)
       SELECT ?, probe, position + 100, last_probe_at, resolved, added_at, removed_at FROM target_probes WHERE target_id = ?`,
      [keep, from]
    );
    // What was watching the merged monitor watches the kept one, and one that was firing stays firing.
    await run(
      `INSERT OR IGNORE INTO alert_targets (alert_id, target_id, state, streak, last_fired_at, last_resolved_at)
       SELECT alert_id, ?, state, streak, last_fired_at, last_resolved_at FROM alert_targets WHERE target_id = ?`,
      [keep, from]
    );
    await run(
      `UPDATE alert_targets SET state = 'firing'
       WHERE target_id = ? AND alert_id IN (SELECT alert_id FROM alert_targets WHERE target_id = ? AND state = 'firing')`,
      [keep, from]
    );
    await run(
      `INSERT OR IGNORE INTO alert_probe_states (alert_id, target_id, probe, in_breach, streak)
       SELECT alert_id, ?, probe, in_breach, streak FROM alert_probe_states WHERE target_id = ?`,
      [keep, from]
    );
    await deleteTargets([from]);
  }

  // Positions were offset to keep each probe after the kept monitor's own;
  // closed up now into 0, 1, 2 in the order they were.
  await closeUpPositions(keep);
  return moved;
}

async function closeUpPositions(targetId: string): Promise<void> {
  const database = await getDatabase();
  const probes = await new Promise<Array<{ probe: string }>>((resolve, reject) => {
    database.all(
      'SELECT probe FROM target_probes WHERE target_id = ? ORDER BY (removed_at IS NOT NULL), position',
      [targetId],
      (error, result) => (error ? reject(error) : resolve((result ?? []) as Array<{ probe: string }>))
    );
  });
  for (const [position, { probe }] of probes.entries()) {
    await run('UPDATE target_probes SET position = ? WHERE target_id = ? AND probe = ?', [position, targetId, probe]);
  }
}
