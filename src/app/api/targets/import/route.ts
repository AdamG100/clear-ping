import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { addTargets } from '@/lib/target-actions';
import { validateTargetDefinition } from '@/lib/target-definition';
import { MAX_SHARED_TARGETS } from '@/lib/target-share';
import type { TargetDefinition } from '@/types/probe';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';

/**
 * Add several targets at once: what importing a share link comes to.
 *
 * All of them or none. Every one is checked before any is stored, so a list
 * with a mistake in it is turned away whole rather than half added.
 */
export async function POST(request: NextRequest) {
  try {
    await initializeServer();

    const body = await request.json();
    const entries: unknown = body?.targets;

    if (!Array.isArray(entries) || entries.length === 0) {
      return NextResponse.json({ error: 'No targets to import' }, { status: 400 });
    }
    if (entries.length > MAX_SHARED_TARGETS) {
      return NextResponse.json(
        { error: `At most ${MAX_SHARED_TARGETS} targets can be imported at once` },
        { status: 400 }
      );
    }

    const definitions: TargetDefinition[] = [];
    for (const [index, entry] of entries.entries()) {
      const definition = validateTargetDefinition(entry);
      if (!definition.ok) {
        return NextResponse.json({ error: `Target ${index + 1}: ${definition.error}` }, { status: 400 });
      }
      definitions.push(definition.target);
    }

    // Placed after everything already here, in the order they were shared in.
    const created = await addTargets(definitions);
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'target.import', created.map(target => target.name).join(', '));
    return NextResponse.json({ created }, { status: 201 });
  } catch (error) {
    console.error('Error importing targets:', error);
    return NextResponse.json(
      { error: 'Failed to import targets' },
      { status: 500 }
    );
  }
}
