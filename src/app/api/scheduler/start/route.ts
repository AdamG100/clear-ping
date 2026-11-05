import { NextResponse } from 'next/server';
import { startScheduler } from '@/lib/scheduler';

/**
 * POST /api/scheduler/start
 * Start the probe scheduler
 *
 * Not where a separate process does the probing (CLEARPING_EXTERNAL_PROBER), or
 * every reading would be taken twice.
 */
export async function POST() {
  if (process.env.CLEARPING_EXTERNAL_PROBER === '1') {
    return NextResponse.json({ error: 'A separate process does the probing here (CLEARPING_EXTERNAL_PROBER)' }, { status: 409 });
  }

  try {
    await startScheduler();

    return NextResponse.json({
      success: true,
      message: 'Scheduler started successfully',
    });
  } catch (error) {
    console.error('Error starting scheduler:', error);
    return NextResponse.json(
      { error: 'Failed to start scheduler' },
      { status: 500 }
    );
  }
}
