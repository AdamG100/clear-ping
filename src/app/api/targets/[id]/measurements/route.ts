import { NextRequest, NextResponse } from 'next/server';
import { getMeasurements, getTargetStatistics } from '@/lib/database';
import { initializeServer } from '@/lib/init';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Ensure server is initialized
    await initializeServer();
    
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    
    const hours = parseInt(searchParams.get('hours') || '24');
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

    const measurements = await getMeasurements(id, startTime, endTime);
    const statistics = await getTargetStatistics(id, startTime, endTime);

    return NextResponse.json({
      measurements,
      statistics,
    });
  } catch (error) {
    console.error('Error fetching measurements:', error);
    return NextResponse.json(
      { error: 'Failed to fetch measurements' },
      { status: 500 }
    );
  }
}
