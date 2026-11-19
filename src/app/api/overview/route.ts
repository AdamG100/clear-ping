import { NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { readOverview } from '@/lib/reports/overview';
import { eitherNames } from '@/lib/targets/monitor-names';

/**
 * GET /api/overview - The last 24 hours, for the overview page
 *
 * Each target's uptime, the events in the day with where each fault lay, and
 * how many targets were in trouble in each quarter of an hour. What is going
 * on right now is in /api/targets.
 */
async function handleGET() {
  try {
    await initializeServer();
    return NextResponse.json(await readOverview());
  } catch (error) {
    console.error('Error building the overview:', error);
    return NextResponse.json({ error: 'Failed to build the overview' }, { status: 500 });
  }
}

// Either name for a monitor in, both out (see monitor-names.ts).
export const GET = eitherNames(handleGET)
