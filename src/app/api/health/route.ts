import { NextResponse } from 'next/server';
import { getScheduler } from '@/lib/scheduler';

/**
 * GET /api/health - Whether the server is up and probing
 *
 * Open whether or not sign-in is on, for the container's health check and
 * anything else watching it; it says nothing about what is monitored.
 */
export function GET() {
  const running = getScheduler().getStatus().isRunning;
  return NextResponse.json({ ok: true, probing: running });
}
