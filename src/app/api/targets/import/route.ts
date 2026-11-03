import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { listProbes, probesNamed } from '@/lib/probe-agents/probes';
import { addTargets } from '@/lib/targets/actions';
import { validateTargetDefinition } from '@/lib/targets/definition';
import { MAX_SHARED_TARGETS } from '@/lib/targets/share';
import type { TargetDefinition } from '@/types/probe';
import type { ProbeId } from '@/types/probe-agent';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';

/**
 * Add several targets at once: what importing a share link or a file comes to.
 *
 * All of them or none. Every one is checked before any is stored, so a list
 * with a mistake in it is turned away whole rather than half added.
 *
 * An entry may name the probes that measure it (`probes: ["Local probe",
 * "Home"]`, as an exported file does). Each name is matched to a probe here;
 * one whose names match nothing is measured by the local probe. The names no
 * probe here has come back as `missingProbes`.
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

    const probes = await listProbes();
    const missing = new Set<string>();
    const definitions: (TargetDefinition & { probes?: ProbeId[] })[] = [];
    for (const [index, entry] of entries.entries()) {
      const definition = validateTargetDefinition(entry);
      if (!definition.ok) {
        return NextResponse.json({ error: `Target ${index + 1}: ${definition.error}` }, { status: 400 });
      }
      const named: unknown = (entry as { probes?: unknown } | null)?.probes;
      const names = Array.isArray(named) ? named.filter((name): name is string => typeof name === 'string').slice(0, 50) : [];
      const matched = names.length > 0 ? await probesNamed(names, probes) : null;
      for (const name of matched?.missing ?? []) missing.add(name);
      definitions.push(matched?.probes.length ? { ...definition.target, probes: matched.probes } : definition.target);
    }

    // Placed after everything already here, in the order they were shared in.
    const created = await addTargets(definitions);
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'target.import', created.map(target => target.name).join(', '));
    return NextResponse.json({ created, missingProbes: [...missing] }, { status: 201 });
  } catch (error) {
    console.error('Error importing targets:', error);
    return NextResponse.json(
      { error: 'Failed to import targets' },
      { status: 500 }
    );
  }
}
