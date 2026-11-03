import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { probePlaces, setProbePlace } from '@/lib/probe-agents/places';
import { actorFor } from '@/lib/security/access';
import { requireAdmin } from '@/lib/security/http';
import { recordActivity } from '@/lib/security/store';

/**
 * GET /api/security/probes/places - The region and network labelled on each probe
 * PATCH /api/security/probes/places - Label one
 * Body: { probe, region?, network? } ("local" for the dashboard's own; empty text takes a label off)
 *
 * Alerts use the labels to ask that a problem is seen from several regions and
 * networks before it counts, and to say where it was seen.
 */
export async function GET(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;
  await initializeServer();
  return NextResponse.json({ places: Object.fromEntries(await probePlaces()) });
}

export async function PATCH(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;
  await initializeServer();

  const body = await request.json().catch(() => null);
  const text = (value: unknown) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : null);
  const region = text(body?.region);
  const network = text(body?.network);
  if (typeof body?.probe !== 'string' || body.probe === '' || region === null || network === null) {
    return NextResponse.json({ error: 'probe is a probe id, and region and network are text' }, { status: 400 });
  }

  const place = await setProbePlace(body.probe, { region, network });
  const { actor, via } = await actorFor(request);
  await recordActivity(actor, via, 'probe.place', `${body.probe}: ${place.region ?? '-'} / ${place.network ?? '-'}`);
  return NextResponse.json({ place });
}
