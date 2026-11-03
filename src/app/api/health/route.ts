import { NextResponse } from 'next/server';
import { getScheduler } from '@/lib/scheduler';
import { databaseOpening } from '@/lib/db/upgrade-progress';

/**
 * GET /api/health - Whether the server is up and probing
 *
 * Open whether or not sign-in is on, for the container's health check and
 * anything else watching it; it says nothing about what is monitored. Healthy
 * while the database is brought up to date, which can take minutes, so the
 * container is not marked unhealthy part-way through an upgrade.
 */
export function GET() {
  const running = getScheduler().getStatus().isRunning;
  return NextResponse.json({ ok: true, probing: running, upgrading: databaseOpening() });
}
