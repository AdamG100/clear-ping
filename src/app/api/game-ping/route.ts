import { NextResponse } from 'next/server';
import { gameSummaries } from '@/lib/game-ping/games';

/**
 * GET /api/game-ping - The games Game Server Ping knows, without their regions
 *
 * Read by the page to fill its list. Each game's regions are asked for once
 * it is picked (`/api/game-ping/<game>`), since a Valve game's come from Valve.
 */
export function GET() {
  return NextResponse.json({ games: gameSummaries() });
}
