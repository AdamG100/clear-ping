import { randomUUID } from 'crypto';
import type { Comparison, ComparisonLine } from '@/types/comparison';
import { getAllTargets, getDatabase } from '../db/database';
import { knownProbeIdsOf } from '../targets/probes';

/**
 * Saved comparisons: a name and the lines (a monitor as one probe measures it)
 * to draw against each other. The lines are drawn from `/api/compare?series=`.
 */

/** The most lines one comparison holds: what a chart can still be read with. */
export const MAX_COMPARISON_LINES = 100;
export const MAX_COMPARISON_NAME = 80;

interface ComparisonRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

function run(sql: string, params: unknown[] = []): Promise<number> {
  return getDatabase().then(
    database =>
      new Promise<number>((resolve, reject) => {
        database.run(sql, params, function (error) {
          if (error) reject(error);
          else resolve(this.changes);
        });
      })
  );
}

function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return getDatabase().then(
    database =>
      new Promise<T[]>((resolve, reject) => {
        database.all(sql, params, (error, rows) => (error ? reject(error) : resolve((rows ?? []) as T[])));
      })
  );
}

export async function listComparisons(): Promise<Comparison[]> {
  const [rows, lines] = await Promise.all([
    all<ComparisonRow>('SELECT id, name, created_at, updated_at FROM comparisons ORDER BY sort_order, created_at'),
    all<{ comparison_id: string; target_id: string; probe: string }>(
      'SELECT comparison_id, target_id, probe FROM comparison_series ORDER BY position'
    ),
  ]);
  const byComparison = new Map<string, ComparisonLine[]>();
  for (const line of lines) {
    byComparison.set(line.comparison_id, [...(byComparison.get(line.comparison_id) ?? []), { targetId: line.target_id, probe: line.probe }]);
  }
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    lines: byComparison.get(row.id) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getComparison(id: string): Promise<Comparison | null> {
  return (await listComparisons()).find(comparison => comparison.id === id) ?? null;
}

/**
 * Check what was sent for a comparison: a name, and lines on monitors that
 * exist, each from a probe that measures (or measured) it. Lines naming
 * something gone are left out rather than refused, so a stale tick cannot fail a save.
 */
export async function readComparisonInput(
  body: Record<string, unknown>,
  partial = false
): Promise<{ ok: true; name?: string; lines?: ComparisonLine[] } | { ok: false; error: string }> {
  const out: { name?: string; lines?: ComparisonLine[] } = {};

  if (body.name !== undefined || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { ok: false, error: 'Give the comparison a name' };
    if (name.length > MAX_COMPARISON_NAME) return { ok: false, error: `A name is at most ${MAX_COMPARISON_NAME} characters` };
    out.name = name;
  }

  if (body.lines !== undefined || !partial) {
    if (!Array.isArray(body.lines)) return { ok: false, error: 'lines is a list of { targetId, probe }' };
    const known = new Map((await getAllTargets()).map(target => [target.id, knownProbeIdsOf(target)]));
    const seen = new Set<string>();
    const lines: ComparisonLine[] = [];
    for (const entry of body.lines.slice(0, MAX_COMPARISON_LINES)) {
      const line = entry as Partial<ComparisonLine> | null;
      if (!line || typeof line.targetId !== 'string' || typeof line.probe !== 'string') {
        return { ok: false, error: 'Each line is { targetId, probe }' };
      }
      const key = `${line.targetId}|${line.probe}`;
      if (seen.has(key) || !known.get(line.targetId)?.includes(line.probe)) continue;
      seen.add(key);
      lines.push({ targetId: line.targetId, probe: line.probe });
    }
    if (lines.length < 2) return { ok: false, error: 'A comparison needs at least two lines' };
    out.lines = lines;
  }
  return { ok: true, ...out };
}

async function writeLines(id: string, lines: ComparisonLine[]): Promise<void> {
  await run('DELETE FROM comparison_series WHERE comparison_id = ?', [id]);
  for (const [position, line] of lines.entries()) {
    await run('INSERT OR IGNORE INTO comparison_series (comparison_id, target_id, probe, position) VALUES (?, ?, ?, ?)', [
      id,
      line.targetId,
      line.probe,
      position,
    ]);
  }
}

export async function createComparison(name: string, lines: ComparisonLine[]): Promise<Comparison> {
  const id = randomUUID();
  const now = Date.now();
  const [{ next }] = await all<{ next: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM comparisons');
  await run('INSERT INTO comparisons (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, name, next, now, now]);
  await writeLines(id, lines);
  return (await getComparison(id))!;
}

export async function updateComparison(id: string, changes: { name?: string; lines?: ComparisonLine[] }): Promise<Comparison | null> {
  if (!(await getComparison(id))) return null;
  if (changes.name !== undefined) await run('UPDATE comparisons SET name = ? WHERE id = ?', [changes.name, id]);
  if (changes.lines !== undefined) await writeLines(id, changes.lines);
  await run('UPDATE comparisons SET updated_at = ? WHERE id = ?', [Date.now(), id]);
  return getComparison(id);
}

export async function deleteComparison(id: string): Promise<boolean> {
  await run('DELETE FROM comparison_series WHERE comparison_id = ?', [id]);
  return (await run('DELETE FROM comparisons WHERE id = ?', [id])) > 0;
}
