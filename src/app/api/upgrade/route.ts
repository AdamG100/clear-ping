import { NextResponse } from 'next/server';
import { upgradeProgress } from '@/lib/db/upgrade-progress';

/**
 * GET /api/upgrade - What opening the database is doing
 *
 * Open whether or not sign-in is on, since nothing can be signed in to until
 * the database is open: it is what the page shown meanwhile reads. It says
 * only what is being done to the database, never what is in it.
 */
export function GET() {
  return NextResponse.json(upgradeProgress(), { headers: { 'Cache-Control': 'no-store' } });
}
