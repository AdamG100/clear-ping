import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { createComparison, listComparisons, readComparisonInput } from '@/lib/comparisons/store';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';

/** GET /api/comparisons - Every saved comparison, with its lines */
export async function GET() {
  try {
    await initializeServer();
    return NextResponse.json({ comparisons: await listComparisons() });
  } catch (error) {
    console.error('Error listing comparisons:', error);
    return NextResponse.json({ error: 'Failed to list the comparisons' }, { status: 500 });
  }
}

/**
 * POST /api/comparisons - Save a comparison
 * Body: { name, lines: [{ targetId, probe }, …] } (at least two lines, which
 * may be monitors from any groups, from any of the probes that measure them)
 */
export async function POST(request: NextRequest) {
  try {
    await initializeServer();
    const body = await request.json().catch(() => null);
    const input = await readComparisonInput(body && typeof body === 'object' ? (body as Record<string, unknown>) : {});
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

    const comparison = await createComparison(input.name!, input.lines!);
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'comparison.add', `${comparison.name} (${comparison.lines.length} lines)`);
    return NextResponse.json(comparison, { status: 201 });
  } catch (error) {
    console.error('Error saving a comparison:', error);
    return NextResponse.json({ error: 'Failed to save the comparison' }, { status: 500 });
  }
}
