/**
 * Next.js startup hook.
 *
 * The scheduler used to be started lazily by whichever API route happened to
 * be hit first, which meant no probing happened until somebody opened the
 * page — close the tab, restart the server, and monitoring was silently dead
 * until the next visit. This runs once when the server boots instead.
 *
 * Set CLEARPING_EXTERNAL_PROBER=1 when running `npm run probe` as its own
 * process, so the two do not both probe the same targets.
 */
export async function register() {
  // Only the Node.js runtime can spawn `ping` or open SQLite.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  if (process.env.CLEARPING_EXTERNAL_PROBER === '1') {
    console.log('[Init] External prober configured; in-process scheduler disabled');
    const { initDatabase } = await import('./lib/database');
    await initDatabase();
    return;
  }

  const { initializeServer } = await import('./lib/init');
  await initializeServer();
}
