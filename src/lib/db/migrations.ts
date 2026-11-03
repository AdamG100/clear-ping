import { randomUUID } from 'crypto';
import { isIP } from 'net';
import type sqlite3 from 'sqlite3';
import { groupWithAncestors, normalizeGroupPath } from '../targets/group-path';

type Database = sqlite3.Database;

/**
 * Changes to the shape of an existing database, applied when it is opened.
 *
 * A new image starts against whatever database the last one left in the data
 * directory, so the upgrade has to happen by itself at boot: nobody running a
 * container is going to be asked to run a script first. The database records
 * how far it has got in `PRAGMA user_version`, and every migration past that
 * point runs once, in order, each inside its own transaction. One that fails
 * leaves the database exactly as it found it and stops the start, rather than
 * letting the app run against a shape it does not expect.
 *
 * To change the schema, append to MIGRATIONS. Never edit or reorder an entry
 * that has shipped: databases that already ran it will not run it again.
 *
 * The columns and tables that predate this list are still brought up to date
 * by the idempotent statements in `initDatabase`, which run first.
 */
interface Migration {
  name: string;
  up: (database: Database) => Promise<void>;
}

function run(database: Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    database.run(sql, params, err => (err ? reject(err) : resolve()));
  });
}

function all<T>(database: Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    database.all(sql, params, (err, rows) => (err ? reject(err) : resolve((rows ?? []) as T[])));
  });
}

async function tableExists(database: Database, table: string): Promise<boolean> {
  const rows = await all(database, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
  return rows.length > 0;
}

/**
 * Groups became paths, with `/` between a group and the one inside it.
 *
 * The column is unchanged; what changes is that two spellings of one path must
 * not be two groups. Names are rewritten to the form the app now writes, so
 * `Home / Lab` and `Home/Lab` saved by an older version land in the same place.
 * A group whose name already had a `/` in it becomes a group inside a group.
 */
async function nestedGroups(database: Database): Promise<void> {
  const targetGroups = await all<{ group_name: string }>(
    database,
    `SELECT DISTINCT group_name FROM targets WHERE group_name IS NOT NULL AND group_name != ''`
  );
  for (const { group_name: stored } of targetGroups) {
    const normalized = normalizeGroupPath(stored);
    if (normalized !== stored) {
      await run(database, 'UPDATE targets SET group_name = ? WHERE group_name = ?', [normalized, stored]);
    }
  }

  const orderedGroups = await all<{ group_name: string }>(database, 'SELECT group_name FROM group_orders');
  for (const { group_name: stored } of orderedGroups) {
    const normalized = normalizeGroupPath(stored);
    if (normalized === stored) continue;
    if (normalized === '') {
      await run(database, 'DELETE FROM group_orders WHERE group_name = ?', [stored]);
    } else {
      // OR REPLACE: two spellings of one path may both have a saved position.
      await run(database, 'UPDATE OR REPLACE group_orders SET group_name = ? WHERE group_name = ?', [
        normalized,
        stored,
      ]);
    }
  }
}

interface LegacyAlertRuleRow {
  target_id: string;
  metric: string;
  threshold: number;
  consecutive_probes: number;
  webhook_url: string | null;
  enabled: number;
  state: string;
  streak: number;
  last_fired_at: number | null;
  last_resolved_at: number | null;
  created_at: number;
}

/**
 * Alerts stopped belonging to one target each.
 *
 * An alert is now a condition and somewhere to announce it, ticked for as many
 * targets as it should watch; `alert_targets` holds the ticks, and with each
 * one how that target currently stands against the condition.
 *
 * Rules made the old way are carried over. Rules that say the same thing on
 * different targets become one alert covering all of them, which is what
 * anyone setting the same rule on ten targets by hand was trying to express.
 * Each target keeps its own state, so an alert that was firing is still
 * firing afterwards and does not announce itself a second time.
 *
 * `alert_rules` is left where it is. Nothing reads it any more, but an older
 * image started against this database still finds its rules there.
 */
async function sharedAlerts(database: Database): Promise<void> {
  await run(database, `
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      metric TEXT NOT NULL,
      threshold REAL NOT NULL DEFAULT 0,
      consecutive_probes INTEGER NOT NULL DEFAULT 3,
      webhook_url TEXT,
      mention_role_ids TEXT,
      mention_user_ids TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`);
  await run(database, `
    CREATE TABLE alert_targets (
      alert_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'ok' CHECK(state IN ('ok','firing')),
      streak INTEGER NOT NULL DEFAULT 0,
      last_fired_at INTEGER,
      last_resolved_at INTEGER,
      PRIMARY KEY (alert_id, target_id),
      FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
    )`);
  await run(database, 'CREATE INDEX idx_alert_targets_target ON alert_targets(target_id)');

  if (!(await tableExists(database, 'alert_rules'))) return;

  // Rules whose target has since been deleted are not carried over: databases
  // from before foreign keys were switched on can still hold some.
  const rules = await all<LegacyAlertRuleRow>(
    database,
    `SELECT * FROM alert_rules WHERE target_id IN (SELECT id FROM targets) ORDER BY created_at ASC`
  );

  const alertIds = new Map<string, string>();
  for (const rule of rules) {
    const same = JSON.stringify([
      rule.metric, rule.threshold, rule.consecutive_probes, rule.webhook_url ?? '', rule.enabled,
    ]);

    let alertId = alertIds.get(same);
    if (!alertId) {
      alertId = randomUUID();
      alertIds.set(same, alertId);
      await run(
        database,
        `INSERT INTO alerts (id, metric, threshold, consecutive_probes, webhook_url, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [alertId, rule.metric, rule.threshold, rule.consecutive_probes, rule.webhook_url, rule.enabled, rule.created_at]
      );
    }

    // OR IGNORE: the same rule set twice on one target is one tick, not two.
    await run(
      database,
      `INSERT OR IGNORE INTO alert_targets (alert_id, target_id, state, streak, last_fired_at, last_resolved_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [alertId, rule.target_id, rule.state === 'firing' ? 'firing' : 'ok', rule.streak, rule.last_fired_at, rule.last_resolved_at]
    );
  }
}

const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
const DISCORD_WEBHOOK_PATH = /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([^/]+)/;

/**
 * Whether a URL is a Discord webhook that wants Discord's own payload. Discord
 * also serves each webhook at `…/slack` and `…/github`, which expect those
 * services' formats instead, so those do not count.
 */
function isDiscordWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return DISCORD_HOSTS.has(parsed.hostname.toLowerCase()) && /^\/api(\/v\d+)?\/webhooks\/\d+\/[^/]+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Where an alert is sent became something it says, rather than something read
 * off its URL each time it fires. Alerts that already have a URL are given the
 * destination the URL would have been taken for, so they go on being sent
 * exactly as they were.
 */
async function alertDestinations(database: Database): Promise<void> {
  await run(database, `ALTER TABLE alerts ADD COLUMN destination TEXT NOT NULL DEFAULT 'none'`);

  const sent = await all<{ id: string; webhook_url: string }>(
    database,
    `SELECT id, webhook_url FROM alerts WHERE webhook_url IS NOT NULL AND webhook_url != ''`
  );
  for (const alert of sent) {
    await run(database, 'UPDATE alerts SET destination = ? WHERE id = ?', [
      isDiscordWebhook(alert.webhook_url) ? 'discord' : 'webhook',
      alert.id,
    ]);
  }
}

function storedIds(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The Apprise URL that reaches wherever an alert was already being sent.
 *
 * - A Discord webhook becomes `discord://`. One that was posted as an embed is
 *   asked for as an embed still (`format=markdown`), and the roles and users
 *   it mentioned go in `ping`.
 * - A Slack webhook is left as it is: Apprise knows Slack by that address.
 * - Any other address becomes `json://`, or `jsons://` for HTTPS, which is
 *   Apprise's name for POSTing JSON to an endpoint. What arrives there is
 *   Apprise's JSON and not the payload this app used to build; that payload
 *   has nothing to carry it any more.
 */
export function legacyNotifyUrls(
  destination: string,
  webhookUrl: string | null,
  roleIds: string[] = [],
  userIds: string[] = []
): string[] {
  if (destination === 'none' || !webhookUrl) return [];

  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    // Nothing could be sent to it before either. Kept, so that "Send test"
    // has something to complain about.
    return [webhookUrl];
  }

  const host = parsed.hostname.toLowerCase();

  const discord = DISCORD_HOSTS.has(host) ? DISCORD_WEBHOOK_PATH.exec(parsed.pathname) : null;
  if (discord) {
    const params = new URLSearchParams();
    if (destination === 'discord') {
      params.set('format', 'markdown');
      const ping = [...roleIds.map(id => `<@&${id}>`), ...userIds.map(id => `<@${id}>`)];
      if (ping.length > 0) params.set('ping', ping.join(','));
    }
    const thread = parsed.searchParams.get('thread_id');
    if (thread) params.set('thread', thread);

    const query = params.toString();
    return [`discord://${discord[1]}/${discord[2]}/${query ? `?${query}` : ''}`];
  }

  if (host === 'hooks.slack.com') return [webhookUrl];

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const params = new URLSearchParams();
    // A `-` in front of a name is how Apprise is told that it belongs in the
    // endpoint's own query string, and is not a setting of Apprise's.
    for (const [name, value] of parsed.searchParams) params.append(`-${name}`, value);
    // The summary this endpoint used to be sent was plain text.
    params.set('format', 'text');

    const login = parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : '';
    const scheme = parsed.protocol === 'https:' ? 'jsons' : 'json';
    return [`${scheme}://${login}${parsed.host}${parsed.pathname}?${params}`];
  }

  return [webhookUrl];
}

/**
 * Alerts stopped having kinds.
 *
 * An alert used to be for Discord or for a webhook, and this app built the
 * message for each. It now holds Apprise URLs, as many as it should be sent
 * to, and Apprise does the sending, to any service it knows. Alerts that were
 * being sent somewhere are given the URL that sends them to the same place.
 *
 * `destination`, `webhook_url` and the two columns of mentions are left where
 * they are. Nothing reads them any more, but an older image started against
 * this database still finds where its alerts were going.
 */
async function appriseNotifications(database: Database): Promise<void> {
  await run(database, `ALTER TABLE alerts ADD COLUMN notify_urls TEXT NOT NULL DEFAULT '[]'`);

  const sent = await all<{
    id: string;
    destination: string;
    webhook_url: string;
    mention_role_ids: string | null;
    mention_user_ids: string | null;
  }>(
    database,
    `SELECT id, destination, webhook_url, mention_role_ids, mention_user_ids FROM alerts
     WHERE destination != 'none' AND webhook_url IS NOT NULL AND webhook_url != ''`
  );
  for (const alert of sent) {
    const urls = legacyNotifyUrls(
      alert.destination,
      alert.webhook_url,
      storedIds(alert.mention_role_ids),
      storedIds(alert.mention_user_ids)
    );
    await run(database, 'UPDATE alerts SET notify_urls = ? WHERE id = ?', [JSON.stringify(urls), alert.id]);
  }
}

/**
 * Groups became things in their own right.
 *
 * A group used to be nothing but a name some target carried. It could not be
 * made before there was a target to put in it, and it was gone the moment its
 * last target left. `target_groups` lists the groups that exist, whether or
 * not anything is in them. Every group in use is entered, along with the
 * groups it sits inside, so none of them disappears the next time it is
 * emptied.
 */
async function keptGroups(database: Database): Promise<void> {
  await run(database, 'CREATE TABLE target_groups (group_name TEXT PRIMARY KEY)');

  const inUse = await all<{ group_name: string }>(
    database,
    `SELECT DISTINCT group_name FROM targets WHERE group_name IS NOT NULL AND group_name != ''`
  );
  for (const { group_name: group } of inUse) {
    for (const path of groupWithAncestors(group)) {
      await run(database, 'INSERT OR IGNORE INTO target_groups (group_name) VALUES (?)', [path]);
    }
  }
}

/** In the order they shipped. A migration's version is its position, from 1. */
/**
 * Accounts, sessions, keys for scripts and assistants, the switches that turn
 * them on, and a record of who changed what. All of it optional: a database
 * with none of it in use behaves as before. See src/lib/security/.
 */
async function security(database: Database): Promise<void> {
  await run(database, `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    )
  `);
  // A session or key is kept only as a hash of itself: a copy of the database
  // does not hand anyone a way in.
  await run(database, `
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )
  `);
  await run(database, `
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      access TEXT NOT NULL CHECK (access IN ('read', 'write')),
      created_at INTEGER NOT NULL,
      created_by TEXT,
      last_used_at INTEGER,
      revoked_at INTEGER
    )
  `);
  await run(database, `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await run(database, `
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT,
      actor_name TEXT NOT NULL,
      via TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT
    )
  `);
  await run(database, 'CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at)');
}

/**
 * Accounts that sign in through an identity provider (Authentik, or any other
 * OpenID Connect provider), known by the provider and its id for the person.
 * An account made that way has no password: its hash is left empty, which no
 * password matches.
 */
async function singleSignOn(database: Database): Promise<void> {
  const columns = await all<{ name: string }>(database, 'PRAGMA table_info(users)');
  const has = (name: string) => columns.some(column => column.name === name);
  if (!has('sso_issuer')) await run(database, 'ALTER TABLE users ADD COLUMN sso_issuer TEXT');
  if (!has('sso_subject')) await run(database, 'ALTER TABLE users ADD COLUMN sso_subject TEXT');
  await run(
    database,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso ON users(sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL'
  );
}

/**
 * Sessions made by signing in through the identity provider remember which
 * sign-in there they came from, so that signing out there can end them here
 * (back-channel logout, which names the person and the provider's session),
 * and keep the ID token to show the provider when signing out here.
 */
async function singleSignOut(database: Database): Promise<void> {
  const columns = await all<{ name: string }>(database, 'PRAGMA table_info(sessions)');
  const has = (name: string) => columns.some(column => column.name === name);
  for (const column of ['sso_issuer', 'sso_subject', 'sso_sid', 'sso_id_token']) {
    if (!has(column)) await run(database, `ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
  }
  await run(database, 'CREATE INDEX IF NOT EXISTS idx_sessions_sso ON sessions(sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL');
}

/**
 * Roles. The accounts already here could do everything, and still can: they
 * are admins. A key remembers the account that made it, so that it can never
 * do more than that account may.
 */
async function roles(database: Database): Promise<void> {
  const users = await all<{ name: string }>(database, 'PRAGMA table_info(users)');
  if (!users.some(column => column.name === 'role')) {
    await run(database, "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'editor', 'viewer'))");
  }
  const keys = await all<{ name: string }>(database, 'PRAGMA table_info(api_keys)');
  if (!keys.some(column => column.name === 'owner_id')) {
    await run(database, 'ALTER TABLE api_keys ADD COLUMN owner_id TEXT');
  }
}

/**
 * An alert says whether it traces the route when it fires, and how long it
 * leaves before tracing the same target again. Until now every loss and
 * unreachable alert traced each time it fired, however often that was: those
 * go on tracing, now with a pause between traces, and the rest start off.
 */
async function alertTraceroutes(database: Database): Promise<void> {
  const columns = await all<{ name: string }>(database, 'PRAGMA table_info(alerts)');
  const has = (name: string) => columns.some(column => column.name === name);
  if (!has('trace_on_fire')) {
    await run(database, 'ALTER TABLE alerts ADD COLUMN trace_on_fire INTEGER NOT NULL DEFAULT 0');
  }
  if (!has('trace_cooldown_minutes')) {
    await run(database, 'ALTER TABLE alerts ADD COLUMN trace_cooldown_minutes INTEGER NOT NULL DEFAULT 15');
  }
  await run(database, `UPDATE alerts SET trace_on_fire = 1 WHERE metric IN ('packetLoss', 'unreachable')`);
}

/**
 * How many routes an alert keeps, and for how many days, plus which alert a
 * saved route was taken for. Routes already saved have no alert, so they stay
 * under the usual retention until they age out.
 */
async function alertTraceRetention(database: Database): Promise<void> {
  const columns = await all<{ name: string }>(database, 'PRAGMA table_info(alerts)');
  const has = (name: string) => columns.some(column => column.name === name);
  // 10 and 30 match DEFAULT_TRACE_KEEP_COUNT and DEFAULT_TRACE_KEEP_DAYS.
  if (!has('trace_keep_count')) {
    await run(database, 'ALTER TABLE alerts ADD COLUMN trace_keep_count INTEGER NOT NULL DEFAULT 10');
  }
  if (!has('trace_keep_days')) {
    await run(database, 'ALTER TABLE alerts ADD COLUMN trace_keep_days INTEGER NOT NULL DEFAULT 30');
  }

  const tables = await all<{ name: string }>(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'traceroutes'");
  if (tables.length === 0) return;
  const traceColumns = await all<{ name: string }>(database, 'PRAGMA table_info(traceroutes)');
  if (!traceColumns.some(column => column.name === 'alert_id')) {
    await run(database, 'ALTER TABLE traceroutes ADD COLUMN alert_id TEXT');
  }
  await run(database, 'CREATE INDEX IF NOT EXISTS idx_traceroutes_alert ON traceroutes(alert_id, timestamp DESC)');
}

/**
 * Probe agents: other machines a target can be probed from. A target with no
 * probe agent is probed from here, as every target was until now.
 *
 * An outage is a stretch when the dashboard could not reach a probe agent. No
 * readings are taken for its targets then, and the charts show the gap as the
 * agent's, not as the targets being down.
 */
async function probeAgents(database: Database): Promise<void> {
  await run(database, `CREATE TABLE IF NOT EXISTS probe_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    address TEXT NOT NULL,
    port INTEGER NOT NULL,
    token TEXT NOT NULL,
    cert_pem TEXT,
    cert_fingerprint TEXT,
    offered_fingerprint TEXT,
    state TEXT NOT NULL DEFAULT 'unpaired',
    last_seen_at INTEGER,
    last_error TEXT,
    version TEXT,
    hostname TEXT,
    platform TEXT,
    tools TEXT,
    exposure TEXT NOT NULL DEFAULT 'public',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await run(database, `CREATE TABLE IF NOT EXISTS probe_agent_outages (
    id TEXT PRIMARY KEY,
    probe_agent_id TEXT NOT NULL REFERENCES probe_agents(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    reason TEXT
  )`);
  await run(database, 'CREATE INDEX IF NOT EXISTS idx_probe_agent_outages ON probe_agent_outages(probe_agent_id, started_at DESC)');

  const columns = await all<{ name: string }>(database, 'PRAGMA table_info(targets)');
  if (!columns.some(column => column.name === 'probe_agent_id')) {
    await run(database, 'ALTER TABLE targets ADD COLUMN probe_agent_id TEXT REFERENCES probe_agents(id)');
  }
}

/**
 * BGP monitoring: the prefixes watched, with what was normal for each, and a
 * short record of what happened to them. The routes themselves are not kept:
 * they are read afresh from RIPE whenever monitoring starts.
 */
async function bgpMonitoring(database: Database): Promise<void> {
  await run(database, `CREATE TABLE IF NOT EXISTS bgp_prefixes (
    id TEXT PRIMARY KEY,
    prefix TEXT NOT NULL UNIQUE,
    label TEXT,
    address TEXT,
    baseline TEXT,
    created_at INTEGER NOT NULL
  )`);
  await run(database, `CREATE TABLE IF NOT EXISTS bgp_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prefix_id TEXT NOT NULL REFERENCES bgp_prefixes(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    collector TEXT NOT NULL,
    peer TEXT NOT NULL,
    prefix TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('announce', 'withdraw')),
    path TEXT,
    previous_path TEXT
  )`);
  await run(database, 'CREATE INDEX IF NOT EXISTS idx_bgp_updates ON bgp_updates(prefix_id, at)');
  await run(database, `CREATE TABLE IF NOT EXISTS bgp_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prefix_id TEXT NOT NULL REFERENCES bgp_prefixes(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'state',
    state TEXT NOT NULL,
    reasons TEXT NOT NULL
  )`);
  await run(database, 'CREATE INDEX IF NOT EXISTS idx_bgp_events ON bgp_events(prefix_id, at)');
  await run(database, `CREATE TABLE IF NOT EXISTS bgp_traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prefix_id TEXT NOT NULL REFERENCES bgp_prefixes(id) ON DELETE CASCADE,
    vantage TEXT NOT NULL,
    at INTEGER NOT NULL,
    address TEXT NOT NULL,
    reached INTEGER NOT NULL,
    error TEXT,
    hops TEXT NOT NULL
  )`);
  await run(database, 'CREATE INDEX IF NOT EXISTS idx_bgp_traces ON bgp_traces(prefix_id, vantage, address, at)');
  await run(database, `CREATE TABLE IF NOT EXISTS bgp_networks (
    asn INTEGER PRIMARY KEY,
    name TEXT,
    country TEXT,
    fetched_at INTEGER NOT NULL
  )`);
}

/** What is left of tagging old readings with the probe that took them; see probe-tags.ts. */
export const PROBE_TAGS_KEY = 'upgrade.probe-tags';

/**
 * A monitor measured from several probes.
 *
 * A target had one `probe_agent_id`: none for this server, otherwise the probe
 * agent it was measured from. It now has a list, in `target_probes`, with the
 * first as its primary probe. `probe_agent_id` stays and holds that primary
 * one, so an older image started against this database still measures each
 * monitor from somewhere sensible.
 *
 * Readings and routes say which probe took them. Every row so far was taken
 * by the probe its target was measured from, so only those of targets on a
 * probe agent need a tag: the column's default, 'local', is right for the rest
 * and costs nothing to add. The tagging itself is not done here: one UPDATE
 * over a long history writes every page of it to the log in one transaction.
 * It is recorded as work to do, and probe-tags.ts does it in small batches
 * before the app serves anything.
 *
 * An alert's state is kept for each probe, so two probes' readings never run
 * one streak between them. Each alert starts with the state its target had.
 */
async function probesPerMonitor(database: Database): Promise<void> {
  await run(database, `CREATE TABLE IF NOT EXISTS target_probes (
    target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    probe TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    last_probe_at INTEGER NOT NULL DEFAULT 0,
    resolved TEXT,
    added_at INTEGER NOT NULL,
    removed_at INTEGER,
    PRIMARY KEY (target_id, probe)
  )`);
  await run(database, 'CREATE INDEX IF NOT EXISTS idx_target_probes_probe ON target_probes(probe)');

  const targets = await all<{
    id: string;
    probe_agent_id: string | null;
    last_probe_at: number | null;
    resolved_address: string | null;
    created_at: number;
  }>(database, 'SELECT id, probe_agent_id, last_probe_at, resolved_address, created_at FROM targets');
  const toTag: Record<string, { agent: string; cursor: number }> = {};
  for (const target of targets) {
    const family = target.resolved_address ? isIP(target.resolved_address) : 0;
    await run(
      database,
      `INSERT OR IGNORE INTO target_probes (target_id, probe, position, last_probe_at, resolved, added_at)
       VALUES (?, ?, 0, ?, ?, ?)`,
      [
        target.id,
        target.probe_agent_id ?? 'local',
        target.last_probe_at ?? 0,
        family === 4 || family === 6 ? JSON.stringify({ [family]: target.resolved_address }) : null,
        target.created_at,
      ]
    );
    if (target.probe_agent_id) toTag[target.id] = { agent: target.probe_agent_id, cursor: 0 };
  }

  const measurementColumns = await all<{ name: string }>(database, 'PRAGMA table_info(measurements)');
  if (!measurementColumns.some(column => column.name === 'probe')) {
    await run(database, "ALTER TABLE measurements ADD COLUMN probe TEXT NOT NULL DEFAULT 'local'");
  }

  if (await tableExists(database, 'traceroutes')) {
    const traceColumns = await all<{ name: string }>(database, 'PRAGMA table_info(traceroutes)');
    if (!traceColumns.some(column => column.name === 'probe')) {
      await run(database, "ALTER TABLE traceroutes ADD COLUMN probe TEXT NOT NULL DEFAULT 'local'");
    }
    await run(database, 'CREATE INDEX IF NOT EXISTS idx_traceroutes_target_probe ON traceroutes(target_id, probe, timestamp DESC)');
  }

  await run(database, `CREATE TABLE IF NOT EXISTS alert_probe_states (
    alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    probe TEXT NOT NULL,
    in_breach INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (alert_id, target_id, probe)
  )`);
  await run(database, `INSERT OR IGNORE INTO alert_probe_states (alert_id, target_id, probe, in_breach, streak)
    SELECT a.alert_id, a.target_id, COALESCE(t.probe_agent_id, 'local'), CASE WHEN a.state = 'firing' THEN 1 ELSE 0 END, a.streak
    FROM alert_targets a JOIN targets t ON t.id = a.target_id`);

  // Done once the readings are tagged and their index built: see probe-tags.ts.
  await run(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
    PROBE_TAGS_KEY,
    JSON.stringify({ migratedAt: Date.now(), targets: toTag, done: false }),
  ]);
}

/**
 * Alert rules: several conditions, how long they must hold, where an alert
 * applies, and how many of a monitor's probes must agree.
 *
 * An existing alert is one condition (the metric and threshold it had), held
 * for the readings in a row it had, on every probe of the monitors ticked for
 * it, and fires when any probe is in breach: exactly what it did. Those old
 * columns are still written from the first condition, for an older image.
 * `alert_scope` holds where it applies besides the ticked monitors (groups,
 * probes); `alert_events` is its history.
 */
async function alertRules(database: Database): Promise<void> {
  const columns = await all<{ name: string }>(database, 'PRAGMA table_info(alerts)');
  const has = (name: string) => columns.some(column => column.name === name);
  for (const [name, definition] of [
    ['conditions', 'TEXT'],
    ['combine', 'TEXT'],
    ['for_minutes', 'INTEGER'],
    ['clear_after', 'INTEGER'],
    ['probe_policy', "TEXT NOT NULL DEFAULT 'any'"],
    ['probe_quorum', 'INTEGER NOT NULL DEFAULT 1'],
    ['probes', 'TEXT'],
    ['probe_agent_offline', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    if (!has(name)) await run(database, `ALTER TABLE alerts ADD COLUMN ${name} ${definition}`);
  }

  await run(database, `CREATE TABLE IF NOT EXISTS alert_scope (
    alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('monitor', 'group', 'probe')),
    ref TEXT NOT NULL,
    PRIMARY KEY (alert_id, kind, ref)
  )`);
  // The monitors ticked are scope entries too.
  await run(database, `INSERT OR IGNORE INTO alert_scope (alert_id, kind, ref) SELECT alert_id, 'monitor', target_id FROM alert_targets`);

  // What a probe remembers about an alert between readings: each condition as last
  // judged, the readings a window averages, and when a run in minutes began.
  const stateColumns = await all<{ name: string }>(database, 'PRAGMA table_info(alert_probe_states)');
  if (!stateColumns.some(column => column.name === 'memory')) await run(database, 'ALTER TABLE alert_probe_states ADD COLUMN memory TEXT');

  await run(database, `CREATE TABLE IF NOT EXISTS alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    transition TEXT NOT NULL CHECK (transition IN ('firing', 'resolved')),
    conditions TEXT NOT NULL,
    probes TEXT NOT NULL,
    reason TEXT NOT NULL
  )`);
  await run(database, 'CREATE INDEX IF NOT EXISTS idx_alert_events_alert ON alert_events(alert_id, at DESC)');
  await run(database, 'CREATE INDEX IF NOT EXISTS idx_alert_events_target ON alert_events(target_id, at DESC)');
}

const MIGRATIONS: Migration[] = [
  { name: 'nested groups', up: nestedGroups },
  { name: 'shared alerts', up: sharedAlerts },
  { name: 'alert destinations', up: alertDestinations },
  { name: 'apprise notifications', up: appriseNotifications },
  { name: 'kept groups', up: keptGroups },
  { name: 'security', up: security },
  { name: 'single sign-on', up: singleSignOn },
  { name: 'single sign-out', up: singleSignOut },
  { name: 'roles', up: roles },
  { name: 'alert traceroutes', up: alertTraceroutes },
  { name: 'probe agents', up: probeAgents },
  { name: 'bgp monitoring', up: bgpMonitoring },
  { name: 'alert trace retention', up: alertTraceRetention },
  { name: 'probes per monitor', up: probesPerMonitor },
  { name: 'alert rules', up: alertRules },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export async function schemaVersion(database: Database): Promise<number> {
  const [row] = await all<{ user_version: number }>(database, 'PRAGMA user_version');
  return row?.user_version ?? 0;
}

export async function runMigrations(database: Database): Promise<void> {
  const found = await schemaVersion(database);

  if (found > SCHEMA_VERSION) {
    // An older image started against a database a newer one has upgraded.
    // There is nothing here that knows how to undo that, and refusing to start
    // would turn a rollback into an outage, so say so and carry on.
    console.warn(
      `Database: schema version ${found} is newer than this build understands (${SCHEMA_VERSION}); ` +
      'it was last opened by a newer version of ClearPing'
    );
    return;
  }

  for (let version = found + 1; version <= SCHEMA_VERSION; version++) {
    const migration = MIGRATIONS[version - 1];

    await run(database, 'BEGIN IMMEDIATE');
    try {
      // Read again now that the write lock is held. The web app and a separate
      // prober open the same file at the same moment, and whichever of them
      // waited for the lock must not repeat what the other just did.
      if ((await schemaVersion(database)) < version) {
        await migration.up(database);
        await run(database, `PRAGMA user_version = ${version}`);
        console.log(`Database: applied migration ${version} (${migration.name})`);
      }
      await run(database, 'COMMIT');
    } catch (error) {
      await run(database, 'ROLLBACK').catch(() => {});
      console.error(`Database: migration ${version} (${migration.name}) failed; the database was left unchanged`);
      throw error;
    }
  }
}
