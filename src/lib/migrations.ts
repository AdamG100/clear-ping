import { randomUUID } from 'crypto';
import type sqlite3 from 'sqlite3';
import { isDiscordWebhook } from './alert-delivery';
import { normalizeGroupPath } from './group-path';

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

/** In the order they shipped. A migration's version is its position, from 1. */
const MIGRATIONS: Migration[] = [
  { name: 'nested groups', up: nestedGroups },
  { name: 'shared alerts', up: sharedAlerts },
  { name: 'alert destinations', up: alertDestinations },
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
