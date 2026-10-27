import { NextRequest, NextResponse } from 'next/server';
import { getTargetById, updateTarget, deleteTarget, pruneEmptyGroups } from '@/lib/db/database';
import { IP_VERSIONS, isIpVersion, isValidHost, normalizeHost } from '@/lib/probes/host';
import { isProbeType, PROBE_TYPES, validateProbeConfig } from '@/lib/probes/config';
import { getScheduler } from '@/lib/scheduler';
import { initializeServer } from '@/lib/init';
import { listProbeAgentSummaries, readProbeAgentChoice } from '@/lib/probe-agents/store';
import type { Target } from '@/types/probe';
import { actorFor } from '@/lib/security/access';
import { recordActivity } from '@/lib/security/store';

const STATUSES = ['active', 'paused', 'error'] as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await initializeServer();
    const { id } = await params;
    const target = await getTargetById(id);

    if (!target) {
      return NextResponse.json(
        { error: 'Target not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(target);
  } catch (error) {
    console.error('Error fetching target:', error);
    return NextResponse.json(
      { error: 'Failed to fetch target' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await initializeServer();

    const { id } = await params;
    const body = await request.json();

    // Only known fields are forwarded. Passing the request body straight to the
    // database let a client set anything the update builder recognised, and an
    // invalid status reached SQLite as a CHECK-constraint failure rather than a
    // 400.
    const updates: Partial<Target> = {};

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
      updates.name = name;
    }

    if (body.host !== undefined) {
      const host = normalizeHost(String(body.host));
      if (!isValidHost(host)) {
        return NextResponse.json(
          { error: 'Invalid host: must be a hostname or an IPv4/IPv6 address' },
          { status: 400 }
        );
      }
      updates.host = host;
    }

    if (body.ipVersion !== undefined) {
      if (!isIpVersion(body.ipVersion)) {
        return NextResponse.json(
          { error: `Invalid IP version. Expected one of: ${IP_VERSIONS.join(', ')}` },
          { status: 400 }
        );
      }
      updates.ipVersion = body.ipVersion;
    }

    if (body.probeType !== undefined) {
      if (!isProbeType(body.probeType)) {
        return NextResponse.json(
          { error: `Invalid probe type. Expected one of: ${PROBE_TYPES.join(', ')}` },
          { status: 400 }
        );
      }
      updates.probeType = body.probeType;
    }

    if (body.interval !== undefined) {
      const interval = Number(body.interval);
      if (!Number.isFinite(interval) || interval < 10 || interval > 86400) {
        return NextResponse.json(
          { error: 'Interval must be between 10 and 86400 seconds' },
          { status: 400 }
        );
      }
      updates.interval = interval;
    }

    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) {
        return NextResponse.json(
          { error: `Invalid status. Expected one of: ${STATUSES.join(', ')}` },
          { status: 400 }
        );
      }
      updates.status = body.status;
    }

    if (body.group !== undefined) {
      // An empty group is a real value here: it is how a target is taken out
      // of its group. Mapping it to undefined made the update skip the field.
      updates.group = body.group ? String(body.group).trim() : '';
    }

    // Null moves it back to being probed from this server.
    const from = await readProbeAgentChoice(body.probeAgentId);
    if (!from.ok) return NextResponse.json({ error: from.error }, { status: 400 });
    if (from.probeAgentId !== undefined) updates.probeAgentId = from.probeAgentId;
    const before = updates.probeAgentId !== undefined ? await getTargetById(id) : null;

    // A probe's settings are only valid for that probe and that host, so
    // changing any of the three means re-checking the settings against what
    // the target is about to become, not against what was sent on its own.
    if (updates.probeType !== undefined || updates.host !== undefined || body.probeConfig !== undefined) {
      const existing = await getTargetById(id);
      if (!existing) {
        return NextResponse.json({ error: 'Target not found' }, { status: 404 });
      }

      const config = validateProbeConfig(
        updates.probeType ?? existing.probeType,
        updates.host ?? existing.host,
        body.probeConfig ?? existing.probeConfig
      );
      if (!config.ok) {
        return NextResponse.json({ error: config.error }, { status: 400 });
      }
      updates.probeConfig = config.config;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No supported fields to update' }, { status: 400 });
    }

    const updated = await updateTarget(id, updates);

    if (!updated) {
      return NextResponse.json(
        { error: 'Target not found' },
        { status: 404 }
      );
    }

    // Pausing, resuming or re-scheduling should take effect now rather than at
    // the scheduler's next five-minute reload.
    await getScheduler().reloadTargets();

    const target = await getTargetById(id);
    const { actor, via } = await actorFor(request);
    const fields = Object.keys(updates).filter(field => field !== 'probeAgentId');
    // Readings before and after a move are from two places, so the record
    // says which two.
    if (before && (before.probeAgentId ?? null) !== updates.probeAgentId) {
      const names = new Map((await listProbeAgentSummaries()).map(agent => [agent.id, agent.name]));
      const place = (agentId: string | null | undefined) => (agentId ? names.get(agentId) ?? 'a removed probe agent' : 'this server');
      fields.push(`probed from ${place(before.probeAgentId)} → ${place(updates.probeAgentId)}`);
    }
    const action = fields.length === 1 && updates.status ? (updates.status === 'paused' ? 'target.pause' : 'target.resume') : 'target.change';
    await recordActivity(actor, via, action, `${target?.name ?? id}${action === 'target.change' && fields.length > 0 ? `: ${fields.join(', ')}` : ''}`);
    return NextResponse.json(target);
  } catch (error) {
    console.error('Error updating target:', error);
    return NextResponse.json(
      { error: 'Failed to update target' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await initializeServer();

    const { id } = await params;
    const existing = await getTargetById(id);
    // Before the rows go, so no probe is started or stored for it meanwhile.
    getScheduler().forget([id]);
    const deleted = await deleteTarget(id);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Target not found' },
        { status: 404 }
      );
    }

    // As with deleting several: a group it leaves empty goes with it.
    await pruneEmptyGroups([existing?.group ?? '']);
    await getScheduler().reloadTargets();
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'target.delete', existing?.name ?? id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting target:', error);
    return NextResponse.json(
      { error: 'Failed to delete target' },
      { status: 500 }
    );
  }
}
