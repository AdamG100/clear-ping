import { NextRequest, NextResponse } from 'next/server';
import { startScheduler } from '@/lib/scheduler';

/**
 * POST /api/scheduler/start
 * Start the probe scheduler
 */
export async function POST(request: NextRequest) {
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
