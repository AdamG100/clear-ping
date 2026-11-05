import { NextRequest, NextResponse } from 'next/server';
import { findGame, regionsOf } from '@/lib/game-ping/games';
import { GamePingBusyError, testRegion } from '@/lib/game-ping/run';
import { initializeServer } from '@/lib/init';
import { LOCAL_PROBE } from '@/types/probe-agent';

/**
 * GET /api/game-ping/:game/test?region=<id>&probe=<id> - Ping one region of a game from one probe
 *
 * A region is named by its id, never by an address, so this reaches only the
 * servers in the list, however it is called. A GET, though it sends packets:
 * it changes nothing, and a viewer, who may look but not change, may use it.
 * Nothing is kept. The page asks once for each region and probe.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ game: string }> }) {
  await initializeServer();
  const game = findGame((await params).game);
  if (!game) return NextResponse.json({ error: 'No such game' }, { status: 404 });

  const regionId = request.nextUrl.searchParams.get('region') ?? '';
  const probe = request.nextUrl.searchParams.get('probe') || LOCAL_PROBE;
  if (probe.length > 100) return NextResponse.json({ error: 'No such probe' }, { status: 400 });

  let region;
  try {
    region = (await regionsOf(game)).find(entry => entry.id === regionId);
  } catch {
    return NextResponse.json({ error: `${game.name}'s list of regions could not be read` }, { status: 502 });
  }
  if (!region) return NextResponse.json({ error: 'No such region' }, { status: 404 });

  try {
    return NextResponse.json(await testRegion(game.id, region, probe), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof GamePingBusyError) {
      return NextResponse.json({ error: error.message }, { status: 429, headers: { 'Retry-After': '5' } });
    }
    console.error(`[Game ping] ${game.name} ${region.label}:`, error);
    return NextResponse.json({ error: 'The test could not be run' }, { status: 500 });
  }
}
