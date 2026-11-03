import { randomUUID } from 'crypto';
import type sqlite3 from 'sqlite3';
import type {
  ProbeAgent,
  ProbeAgentExposure,
  ProbeAgentOutage,
  ProbeAgentState,
  ProbeAgentSummary,
} from '@/types/probe-agent';
import { getDatabase } from '../db/database';
import { PROBE_AGENT_TOKEN_PREFIX, type ProbeAgentInfo } from './protocol';
import { newToken } from '../security/secrets';
import { recordSecurityActivity } from '../security/settings-store';

/**
 * Probe agents as they are kept: where each one is, the token it answers to,
 * the certificate it is pinned to, and how it was the last time it was asked.
 *
 * The token is the one thing here never handed out again after it is made:
 * the dashboard needs it to talk to the agent, so it is kept as it is (as the
 * single sign-on secret is), and only ever leaves in that conversation.
 */

type Database = sqlite3.Database;

function run(database: Database, sql: string, params: unknown[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this.changes);
    });
  });
}

function all<T>(database: Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows) => (error ? reject(error) : resolve((rows ?? []) as T[])));
  });
}

interface ProbeAgentRow {
  id: string;
  name: string;
  address: string;
  port: number;
  token: string;
  cert_pem: string | null;
  cert_fingerprint: string | null;
  offered_fingerprint: string | null;
  state: ProbeAgentState;
  last_seen_at: number | null;
  last_error: string | null;
  version: string | null;
  hostname: string | null;
  platform: string | null;
  tools: string | null;
  exposure: ProbeAgentExposure;
  created_at: number;
  updated_at: number;
  target_count?: number;
}

/** What the dashboard needs to talk to a probe agent. Server-side only: it has the token. */
export interface ProbeAgentConnection {
  id: string;
  name: string;
  address: string;
  port: number;
  token: string;
  certPem: string | null;
  fingerprint: string | null;
  offeredFingerprint: string | null;
  state: ProbeAgentState;
}

/** The states in which a probe agent cannot take readings. Entering one begins an outage. */
const DOWN_STATES: ReadonlySet<ProbeAgentState> = new Set(['offline', 'cert-changed', 'token-rejected', 'outdated']);

export function isProbeAgentDown(state: ProbeAgentState): boolean {
  return DOWN_STATES.has(state);
}

/** A change made by ClearPing itself rather than by anyone, as the activity record shows it. */
const CLEARPING = { kind: 'anonymous', name: 'ClearPing' } as const;

function parseTools(value: string | null): ProbeAgent['tools'] {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function summaryOf(row: ProbeAgentRow): ProbeAgentSummary {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    exposure: row.exposure,
    address: row.address,
    hostname: row.hostname ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
  };
}

function agentOf(row: ProbeAgentRow): ProbeAgent {
  return {
    ...summaryOf(row),
    port: row.port,
    fingerprint: row.cert_fingerprint ?? undefined,
    offeredFingerprint: row.offered_fingerprint ?? undefined,
    lastError: row.last_error ?? undefined,
    version: row.version ?? undefined,
    platform: row.platform ?? undefined,
    tools: parseTools(row.tools),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    targetCount: row.target_count ?? 0,
  };
}

function connectionOf(row: ProbeAgentRow): ProbeAgentConnection {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    port: row.port,
    token: row.token,
    certPem: row.cert_pem,
    fingerprint: row.cert_fingerprint,
    offeredFingerprint: row.offered_fingerprint,
    state: row.state,
  };
}

const WITH_COUNTS = `
  SELECT probe_agents.*, (SELECT COUNT(*) FROM target_probes WHERE target_probes.probe = probe_agents.id AND target_probes.removed_at IS NULL) AS target_count
  FROM probe_agents`;

export async function listProbeAgents(): Promise<ProbeAgent[]> {
  const rows = await all<ProbeAgentRow>(await getDatabase(), `${WITH_COUNTS} ORDER BY name COLLATE NOCASE`);
  return rows.map(agentOf);
}

export async function listProbeAgentSummaries(): Promise<ProbeAgentSummary[]> {
  const rows = await all<ProbeAgentRow>(await getDatabase(), 'SELECT * FROM probe_agents ORDER BY name COLLATE NOCASE');
  return rows.map(summaryOf);
}

export async function getProbeAgent(id: string): Promise<ProbeAgent | null> {
  const [row] = await all<ProbeAgentRow>(await getDatabase(), `${WITH_COUNTS} WHERE probe_agents.id = ?`, [id]);
  return row ? agentOf(row) : null;
}

export async function getProbeAgentConnection(id: string): Promise<ProbeAgentConnection | null> {
  const [row] = await all<ProbeAgentRow>(await getDatabase(), 'SELECT * FROM probe_agents WHERE id = ?', [id]);
  return row ? connectionOf(row) : null;
}

/** Every probe agent that has been connected to at least once, for the health checks. */
export async function pairedProbeAgentConnections(): Promise<ProbeAgentConnection[]> {
  const rows = await all<ProbeAgentRow>(await getDatabase(), 'SELECT * FROM probe_agents WHERE cert_pem IS NOT NULL');
  return rows.map(connectionOf);
}

/** By id, or by name ignoring case: how an assistant names one. */
export async function findProbeAgent(idOrName: string): Promise<ProbeAgentSummary | null> {
  const [row] = await all<ProbeAgentRow>(
    await getDatabase(),
    'SELECT * FROM probe_agents WHERE id = ? OR name = ? COLLATE NOCASE LIMIT 1',
    [idOrName, idOrName]
  );
  return row ? summaryOf(row) : null;
}

/**
 * Where a target is to be probed from, as a request said it: null, empty or
 * "local" for this server, or a probe agent's id (or, from an assistant, its
 * name). Undefined when the request did not say.
 */
export async function readProbeAgentChoice(
  raw: unknown
): Promise<{ ok: true; probeAgentId: string | null | undefined } | { ok: false; error: string }> {
  if (raw === undefined) return { ok: true, probeAgentId: undefined };
  if (raw === null || raw === '' || raw === 'local') return { ok: true, probeAgentId: null };
  if (typeof raw !== 'string') return { ok: false, error: 'probeAgentId is a probe agent id, or null for this server' };
  const agent = await findProbeAgent(raw);
  if (!agent) return { ok: false, error: `No probe agent called ${raw}` };
  return { ok: true, probeAgentId: agent.id };
}

export async function probeAgentNameTaken(name: string, exceptId?: string): Promise<boolean> {
  const rows = await all(
    await getDatabase(),
    'SELECT 1 FROM probe_agents WHERE name = ? COLLATE NOCASE AND id != ?',
    [name, exceptId ?? '']
  );
  return rows.length > 0;
}

export interface NewProbeAgent {
  name: string;
  address: string;
  port: number;
  exposure: ProbeAgentExposure;
}

/** Add a probe agent. The token is returned here and never again. */
export async function createProbeAgent(input: NewProbeAgent): Promise<{ probeAgent: ProbeAgent; token: string }> {
  const id = randomUUID();
  const token = newToken(PROBE_AGENT_TOKEN_PREFIX);
  const now = Date.now();
  await run(
    await getDatabase(),
    `INSERT INTO probe_agents (id, name, address, port, token, exposure, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.name, input.address, input.port, token, input.exposure, now, now]
  );
  return { probeAgent: (await getProbeAgent(id))!, token };
}

export async function updateProbeAgent(id: string, changes: Partial<NewProbeAgent>): Promise<ProbeAgent | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of [
    ['name', changes.name],
    ['address', changes.address],
    ['port', changes.port],
    ['exposure', changes.exposure],
  ] as const) {
    if (value === undefined) continue;
    fields.push(`${column} = ?`);
    values.push(value);
  }
  if (fields.length > 0) {
    await run(await getDatabase(), `UPDATE probe_agents SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`, [
      ...values,
      Date.now(),
      id,
    ]);
  }
  return getProbeAgent(id);
}

/** A new token in place of the old one, which stops working the moment the agent is given this. */
export async function renewProbeAgentToken(id: string): Promise<string | null> {
  const token = newToken(PROBE_AGENT_TOKEN_PREFIX);
  const changed = await run(await getDatabase(), 'UPDATE probe_agents SET token = ?, updated_at = ? WHERE id = ?', [
    token,
    Date.now(),
    id,
  ]);
  return changed > 0 ? token : null;
}

/** The names of the targets probed from it: a probe agent cannot be removed while there are any. */
export async function targetsUsingProbeAgent(id: string): Promise<string[]> {
  const rows = await all<{ name: string }>(
    await getDatabase(),
    'SELECT t.name FROM target_probes p JOIN targets t ON t.id = p.target_id WHERE p.probe = ? AND p.removed_at IS NULL ORDER BY t.name COLLATE NOCASE',
    [id]
  );
  return rows.map(row => row.name);
}

export async function deleteProbeAgent(id: string): Promise<boolean> {
  return (await run(await getDatabase(), 'DELETE FROM probe_agents WHERE id = ?', [id])) > 0;
}

/** Trust this certificate for the agent from now on. */
export async function pinProbeAgentCertificate(id: string, certPem: string, fingerprint: string): Promise<void> {
  await run(
    await getDatabase(),
    'UPDATE probe_agents SET cert_pem = ?, cert_fingerprint = ?, offered_fingerprint = NULL, updated_at = ? WHERE id = ?',
    [certPem, fingerprint, Date.now(), id]
  );
}

/** Forget the pinned certificate, so the next connection pairs afresh. */
export async function unpinProbeAgentCertificate(id: string): Promise<void> {
  await run(
    await getDatabase(),
    'UPDATE probe_agents SET cert_pem = NULL, cert_fingerprint = NULL, updated_at = ? WHERE id = ?',
    [Date.now(), id]
  );
}

/** Send the alerts that asked a probe agent's change. Loaded when needed: alerts import this file. */
async function tellAlerts(name: string, change: { kind: 'offline'; reason: string } | { kind: 'online' }): Promise<void> {
  try {
    const { dispatchProbeAgentChange } = await import('../alerts/store');
    await dispatchProbeAgentChange(name, change);
  } catch (error) {
    console.error('[ProbeAgents] Could not tell the alerts:', error);
  }
}

/**
 * Note how a probe agent is now, and if that is a change, say so: in the
 * activity record, and by opening or closing an outage. An outage is a
 * working agent going down; one that never worked has none. The update only
 * matches a row still in the state it was read in, so two processes noticing
 * the same change at once record it once.
 */
export async function setProbeAgentState(
  id: string,
  state: ProbeAgentState,
  details: { error?: string; info?: ProbeAgentInfo; offeredFingerprint?: string } = {}
): Promise<ProbeAgentState> {
  const database = await getDatabase();
  const now = Date.now();
  const { info } = details;

  const sets = ['last_error = ?', 'updated_at = ?'];
  const values: unknown[] = [details.error ?? null, now];
  if (state === 'online') {
    sets.push('last_seen_at = ?', 'offered_fingerprint = NULL');
    values.push(now);
  }
  if (details.offeredFingerprint !== undefined) {
    sets.push('offered_fingerprint = ?');
    values.push(details.offeredFingerprint);
  }
  if (info) {
    sets.push('version = ?', 'hostname = ?', 'platform = ?', 'tools = ?');
    values.push(info.version, info.hostname, `${info.platform} ${info.arch}`, JSON.stringify(info.tools));
  }
  await run(database, `UPDATE probe_agents SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);

  const [before] = await all<{ name: string; state: ProbeAgentState; last_seen_at: number | null }>(
    database,
    'SELECT name, state, last_seen_at FROM probe_agents WHERE id = ?',
    [id]
  );
  if (!before) return state;
  // Not answering is only "offline" once it has gone on for the time set in
  // Settings: until then it is still counted as working, so one dropped check
  // does not start a notification. The other states (a certificate or token it
  // will not accept, a different version) are not a missed heartbeat and apply at once.
  if (state === 'offline' && before.state === 'online' && before.last_seen_at !== null) {
    const { offlineAfterMinutes } = await import('./heartbeat');
    if (now - before.last_seen_at < (await offlineAfterMinutes()) * 60_000) return before.state;
  }
  const changed = await run(database, 'UPDATE probe_agents SET state = ? WHERE id = ? AND state = ?', [
    state,
    id,
    before.state,
  ]);
  if (changed === 0 || before.state === state) return changed === 0 ? ((await all<{ state: ProbeAgentState }>(database, 'SELECT state FROM probe_agents WHERE id = ?', [id]))[0]?.state ?? state) : state;

  if (before.state === 'online' && isProbeAgentDown(state)) {
    await run(database, 'INSERT INTO probe_agent_outages (id, probe_agent_id, started_at, reason) VALUES (?, ?, ?, ?)', [
      randomUUID(),
      id,
      now,
      details.error ?? state,
    ]);
    await recordSecurityActivity(CLEARPING, 'dashboard', 'probe-agent.offline', `${before.name}: ${details.error ?? state}`);
    void tellAlerts(before.name, { kind: 'offline', reason: details.error ?? state });
  } else if (state === 'online') {
    const closed = await run(
      database,
      'UPDATE probe_agent_outages SET ended_at = ? WHERE probe_agent_id = ? AND ended_at IS NULL',
      [now, id]
    );
    if (closed > 0) {
      await recordSecurityActivity(CLEARPING, 'dashboard', 'probe-agent.online', before.name);
      void tellAlerts(before.name, { kind: 'online' });
    }
  }
  return state;
}

/** The outages of a probe agent that overlap a stretch of time, oldest first. */
export async function probeAgentOutages(id: string, start: number, end: number): Promise<ProbeAgentOutage[]> {
  const rows = await all<{ started_at: number; ended_at: number | null }>(
    await getDatabase(),
    `SELECT started_at, ended_at FROM probe_agent_outages
     WHERE probe_agent_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
     ORDER BY started_at`,
    [id, end, start]
  );
  return rows.map(row => ({ start: row.started_at, end: row.ended_at }));
}

/** When the outage a probe agent is in now began, or null. */
export async function currentOutageStart(id: string): Promise<number | null> {
  const [row] = await all<{ started_at: number }>(
    await getDatabase(),
    'SELECT started_at FROM probe_agent_outages WHERE probe_agent_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
    [id]
  );
  return row?.started_at ?? null;
}

export async function cleanOldProbeAgentOutages(daysToKeep: number): Promise<number> {
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  return run(await getDatabase(), 'DELETE FROM probe_agent_outages WHERE ended_at IS NOT NULL AND ended_at < ?', [cutoff]);
}
