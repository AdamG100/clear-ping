import { NextRequest, NextResponse } from 'next/server';
import { getAllTargets, updateTarget } from '@/lib/db/database';
import { initializeServer } from '@/lib/init';
import { DNS_PROTOCOLS, resolverLabel } from '@/lib/probes/dns/resolvers';
import { probeNames } from '@/lib/probe-agents/probes';
import { getScheduler } from '@/lib/scheduler';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';
import { isWithinGroup, normalizeGroupPath } from '@/lib/targets/group-path';
import { probeIdsOf } from '@/lib/targets/probes';
import { changedResolvers, probesLeftWithout, type ResolverProbeChange } from '@/lib/targets/resolver-probes';
import type { DnsProtocol } from '@/types/probe';

function readChange(raw: unknown): ResolverProbeChange | null {
  const { protocol, server, probe, asked } = (raw ?? {}) as Record<string, unknown>;
  if (!DNS_PROTOCOLS.includes(protocol as DnsProtocol) || typeof probe !== 'string' || !probe || typeof asked !== 'boolean') return null;
  if (server !== undefined && typeof server !== 'string') return null;
  return { protocol: protocol as DnsProtocol, ...(server ? { server } : {}), probe, asked };
}

/**
 * PATCH /api/groups/resolvers - Which probes ask which resolvers, across a group
 * Body: { group: string, changes: [{ protocol, server?, probe, asked }] }
 *
 * For every DNS monitor in the group, and in groups inside it, that asks that
 * resolver. Refused, with the monitors named, if any of their probes would be
 * left with no resolver to ask; nothing is changed then.
 */
export async function PATCH(request: NextRequest) {
  try {
    await initializeServer();

    const body = await request.json().catch(() => null);
    const group = normalizeGroupPath(typeof body?.group === 'string' ? body.group : '');
    if (!group) return NextResponse.json({ error: 'Which group to change is required' }, { status: 400 });
    if (!Array.isArray(body?.changes)) return NextResponse.json({ error: 'changes is a list' }, { status: 400 });

    const changes = body.changes.map(readChange);
    if (changes.some((change: ResolverProbeChange | null) => change === null)) {
      return NextResponse.json({ error: 'Each change is { protocol, server, probe, asked }' }, { status: 400 });
    }
    if (changes.length === 0) return NextResponse.json({ updated: 0 });

    const planned = [];
    const stranded: string[] = [];
    for (const target of await getAllTargets()) {
      if (!target.group || !isWithinGroup(target.group, group)) continue;
      const before = target.probeConfig?.resolvers;
      if (!before?.length) continue;
      const after = changedResolvers(before, changes as ResolverProbeChange[]);
      if (JSON.stringify(after) === JSON.stringify(before)) continue;
      if (probesLeftWithout(after, probeIdsOf(target)).length > 0) stranded.push(target.name);
      planned.push({ target, after });
    }
    if (stranded.length > 0) {
      const names = stranded.slice(0, 5).join(', ') + (stranded.length > 5 ? ` and ${stranded.length - 5} more` : '');
      return NextResponse.json(
        { error: `That would leave a probe of ${names} with no resolver to ask. Keep at least one ticked for each probe.`, stranded },
        { status: 409 }
      );
    }

    for (const { target, after } of planned) {
      await updateTarget(target.id, { probeConfig: { ...target.probeConfig, resolvers: after } });
    }
    if (planned.length > 0) await getScheduler().reloadTargets();

    const names = await probeNames((changes as ResolverProbeChange[]).map(change => change.probe));
    const said = (changes as ResolverProbeChange[])
      .map(change => `${resolverLabel(change)} ${change.asked ? 'asked from' : 'not asked from'} ${names.get(change.probe)}`)
      .join(', ');
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'group.resolvers', `${group}: ${said} (${planned.length} changed)`);
    return NextResponse.json({ updated: planned.length });
  } catch (error) {
    console.error('Error changing which probes ask which resolvers:', error);
    return NextResponse.json({ error: 'Could not change which probes ask which resolvers' }, { status: 500 });
  }
}
