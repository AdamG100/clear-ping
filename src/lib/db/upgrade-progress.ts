/**
 * What opening the database is doing, for the page shown while it does it.
 *
 * Bringing an older database up to date can take a while: migrations, tagging
 * the readings probe agents took, building an index, refreshing statistics.
 * Until it is done no page or API request can be answered, so instead of a
 * browser waiting on nothing, the proxy shows a page that reads this and says
 * what is happening.
 *
 * In memory, and held on globalThis: the proxy, the routes and the database
 * code are bundled apart but run in one process. It imports nothing, so the
 * proxy can read it without loading SQLite.
 */

export type UpgradeStepStatus = 'running' | 'done' | 'failed';

export interface UpgradeStep {
  id: string;
  label: string;
  status: UpgradeStepStatus;
  /** How far through, for a step that can say. */
  done?: number;
  total?: number;
  /** What it came to: "152,765 readings". */
  detail?: string;
}

export interface UpgradeProgress {
  /** `opening` until the database is ready; `ready` after; `failed` if it could not be opened. */
  phase: 'opening' | 'ready' | 'failed';
  startedAt: number;
  /** The schema version it was found at, and the one it is being brought to. */
  from?: number;
  to?: number;
  steps: UpgradeStep[];
  error?: string;
}

/** One upgrade, as kept afterwards: when, from which schema version to which, and what was done. */
export interface UpgradeRecord {
  at: number;
  from?: number;
  to?: number;
  tookMs: number;
  steps: Array<{ label: string; detail?: string }>;
}

const KEY = Symbol.for('clearping.upgrade-progress');
type Store = typeof globalThis & { [KEY]?: UpgradeProgress };

function store(): UpgradeProgress {
  const global = globalThis as Store;
  return (global[KEY] ??= { phase: 'opening', startedAt: Date.now(), steps: [] });
}

export function upgradeProgress(): UpgradeProgress {
  const current = store();
  return { ...current, steps: current.steps.map(step => ({ ...step })) };
}

/** Whether requests should be told to wait: the database is not open yet. */
export function databaseOpening(): boolean {
  return store().phase === 'opening';
}

export function noteVersions(from: number, to: number): void {
  Object.assign(store(), { from, to });
}

export function stepStarted(id: string, label: string, total?: number): void {
  const steps = store().steps;
  const existing = steps.find(step => step.id === id);
  if (existing) Object.assign(existing, { label, status: 'running', total, done: total !== undefined ? 0 : undefined });
  else steps.push({ id, label, status: 'running', ...(total !== undefined ? { total, done: 0 } : {}) });
}

export function stepProgress(id: string, done: number): void {
  const step = store().steps.find(each => each.id === id);
  if (step) step.done = done;
}

export function stepDone(id: string, detail?: string): void {
  const step = store().steps.find(each => each.id === id);
  if (step) Object.assign(step, { status: 'done', ...(detail ? { detail } : {}) });
}

export function databaseReady(): void {
  Object.assign(store(), { phase: 'ready', error: undefined });
}

export function databaseFailed(message: string): void {
  const current = store();
  // What was under way when it stopped did not finish.
  for (const step of current.steps) if (step.status === 'running') step.status = 'failed';
  Object.assign(current, { phase: 'failed', error: message });
}

/** Opening again in this process (the tests, a closed database): start a fresh record. */
export function databaseOpeningAgain(): void {
  (globalThis as Store)[KEY] = { phase: 'opening', startedAt: Date.now(), steps: [] };
}
