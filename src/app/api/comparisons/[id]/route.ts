import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { deleteComparison, getComparison, readComparisonInput, updateComparison } from '@/lib/comparisons/store';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';

type Context = { params: Promise<{ id: string }> };

/** GET /api/comparisons/[id] - One saved comparison */
export async function GET(_request: NextRequest, { params }: Context) {
  try {
    await initializeServer();
    const comparison = await getComparison((await params).id);
    return comparison ? NextResponse.json(comparison) : NextResponse.json({ error: 'Comparison not found' }, { status: 404 });
  } catch (error) {
    console.error('Error reading a comparison:', error);
    return NextResponse.json({ error: 'Failed to read the comparison' }, { status: 500 });
  }
}

/** PATCH /api/comparisons/[id] - Rename it, or change its lines. Body: { name?, lines? } */
export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    await initializeServer();
    const body = await request.json().catch(() => null);
    const input = await readComparisonInput(body && typeof body === 'object' ? (body as Record<string, unknown>) : {}, true);
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
    if (input.name === undefined && input.lines === undefined) {
      return NextResponse.json({ error: 'Nothing to change: give a name or lines' }, { status: 400 });
    }

    const comparison = await updateComparison((await params).id, { name: input.name, lines: input.lines });
    if (!comparison) return NextResponse.json({ error: 'Comparison not found' }, { status: 404 });
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'comparison.change', comparison.name);
    return NextResponse.json(comparison);
  } catch (error) {
    console.error('Error changing a comparison:', error);
    return NextResponse.json({ error: 'Failed to change the comparison' }, { status: 500 });
  }
}

/** DELETE /api/comparisons/[id] - Delete it. The monitors in it are untouched. */
export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    await initializeServer();
    const { id } = await params;
    const comparison = await getComparison(id);
    if (!comparison || !(await deleteComparison(id))) return NextResponse.json({ error: 'Comparison not found' }, { status: 404 });
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'comparison.delete', comparison.name);
    return NextResponse.json({ deleted: 1 });
  } catch (error) {
    console.error('Error deleting a comparison:', error);
    return NextResponse.json({ error: 'Failed to delete the comparison' }, { status: 500 });
  }
}
