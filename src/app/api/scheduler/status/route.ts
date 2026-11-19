import { NextResponse } from 'next/server';
import { getScheduler } from '@/lib/scheduler';
import { eitherNames } from '@/lib/targets/monitor-names';

/**
 * GET /api/scheduler/status
 * Get the current status of the probe scheduler
 */
async function handleGET() {
  try {
    const scheduler = getScheduler();
    const status = scheduler.getStatus();

    return NextResponse.json(status);
  } catch (error) {
    console.error('Error getting scheduler status:', error);
    return NextResponse.json(
      { error: 'Failed to get scheduler status' },
      { status: 500 }
    );
  }
}

// Either name for a monitor in, both out (see monitor-names.ts).
export const GET = eitherNames(handleGET)
