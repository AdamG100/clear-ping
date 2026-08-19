/**
 * Standalone probe runner.
 *
 * Runs the scheduler in its own process, writing to the same SQLite file the
 * Next.js app reads. Probing then continues whether or not the web UI is
 * running, and probe work no longer shares an event loop with request
 * handling.
 *
 *   npm run probe
 *
 * Start the web app with CLEARPING_EXTERNAL_PROBER=1 so it does not also
 * schedule probes.
 */

import { closeDatabase, initDatabase } from '../src/lib/database';
import { getScheduler, startScheduler, stopScheduler } from '../src/lib/scheduler';

async function main() {
  console.log('[Prober] Starting standalone probe runner');
  console.log(`[Prober] Database: ${process.env.CLEARPING_DB_PATH ?? '<cwd>/data/clearping.db'}`);

  await initDatabase();
  await startScheduler();

  const status = getScheduler().getStatus();
  console.log(`[Prober] Scheduling ${status.targetCount} active target(s)`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[Prober] ${signal} received, shutting down`);
    stopScheduler();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Surface failures loudly rather than leaving a half-dead prober running.
  process.on('unhandledRejection', reason => {
    console.error('[Prober] Unhandled rejection:', reason);
  });
}

main().catch(error => {
  console.error('[Prober] Failed to start:', error);
  process.exit(1);
});
