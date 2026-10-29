/**
 * Server Initialization
 *
 * Prepares the database and starts the probe scheduler. Invoked from
 * instrumentation.ts at server boot, and defensively from API routes so that a
 * request can never be served against an uninitialised database.
 */

import { getBgpMonitor } from './bgp/monitor';
import { startScheduler } from './scheduler';
import { initDatabase } from './db/database';
import { startMaintenanceSchedule } from './db/maintenance';
import { getPrivacySettings } from './privacy/settings';
import { recoveryMode } from './security/settings-store';
import { announceSetupCode } from './security/setup-code';
import { countUsers } from './security/store';

/**
 * Held on globalThis for the same reason the scheduler is: route handlers are
 * bundled into separate module graphs, so a module-local flag is not shared
 * and initialisation would run more than once.
 */
const INIT_KEY = Symbol.for('clearping.init');

type InitGlobal = typeof globalThis & {
  [INIT_KEY]?: Promise<void>;
};

/**
 * Initialize the server and start background services.
 *
 * Returns the same promise to concurrent callers, so simultaneous first
 * requests cannot race two initialisations against each other.
 */
export function initializeServer(): Promise<void> {
  const store = globalThis as InitGlobal;

  if (!store[INIT_KEY]) {
    store[INIT_KEY] = (async () => {
      console.log('[Init] Initializing ClearPing server...');
      await initDatabase();
      // Held in memory from here on, for what reads it without waiting.
      await getPrivacySettings();

      if (process.env.CLEARPING_EXTERNAL_PROBER === '1') {
        console.log('[Init] External prober configured; scheduler not started here');
      } else {
        await startScheduler();
      }

      // Whichever process does the probing, this one holds the settings and
      // the database the schedule is read from.
      startMaintenanceSchedule();

      // BGP monitoring, if it is turned on. Not awaited: it reads every
      // watched prefix from RIPE first, and nothing else waits on that.
      void getBgpMonitor().start().catch(error => console.error('[BGP] Could not start:', error));

      if ((await countUsers()) === 0 && !recoveryMode()) announceSetupCode();

      console.log('[Init] Server initialization complete');
    })().catch(error => {
      // Let the next request retry rather than caching a failed startup.
      store[INIT_KEY] = undefined;
      throw error;
    });
  }

  return store[INIT_KEY];
}

export function isInitialized(): boolean {
  return (globalThis as InitGlobal)[INIT_KEY] !== undefined;
}
