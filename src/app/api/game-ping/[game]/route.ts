import { NextResponse } from 'next/server';
import { findGame, regionsOf } from '@/lib/game-ping/games';

/** GET /api/game-ping/:game - A game's regions, read from the publisher's own list where it keeps one. */
export async function GET(_request: Request, { params }: { params: Promise<{ game: string }> }) {
  const game = findGame((await params).game);
  if (!game) return NextResponse.json({ error: 'No such game' }, { status: 404 });
  try {
    return NextResponse.json({ regions: await regionsOf(game) });
  } catch (error) {
    console.error(`[Game ping] Could not read the regions of ${game.name}:`, error);
    return NextResponse.json({ error: `${game.name}'s list of regions could not be read. Try again in a moment.` }, { status: 502 });
  }
}
