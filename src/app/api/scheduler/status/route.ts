import { NextResponse } from 'next/server';
import { getScheduler } from '@/lib/scheduler';

/**
 * GET /api/scheduler/status
 * Get the current status of the probe scheduler
 */
export async function GET() {
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
