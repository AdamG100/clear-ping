import { NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { upgradeProgress } from '@/lib/db/upgrade-progress';

/**
 * POST /api/upgrade/retry - Open the database again, after it could not be
 *
 * For "Try again" on the page shown meanwhile, once what stopped it (a file
 * the container cannot write, say) has been fixed, so it need not be
 * restarted. Open like that page, since nobody can sign in until the database
 * is open, and only does anything while opening it has failed.
 */
export function POST() {
  if (upgradeProgress().phase !== 'failed') {
    return NextResponse.json({ error: 'The database is not in a failed state' }, { status: 409 });
  }
  void initializeServer().catch(error => console.error('[Init] Could not start:', error));
  return NextResponse.json({ retrying: true }, { status: 202 });
}
