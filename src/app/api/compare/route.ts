import { NextRequest, NextResponse } from 'next/server';
import { getAllTargets, getBucketedMeasurements, getResolverRounds, getTargetStatistics } from '@/lib/db/database';
import { resolverSeries } from '@/lib/charts/dns-resolver-series';
import { isDualStack } from '@/lib/probes/host';
import { initializeServer } from '@/lib/init';
import { MAX_COMPARED_TARGETS, windowFromQuery } from '@/lib/charts/series';
import { chosenProbe, knownProbeIdsOf, probeIdsOf } from '@/lib/targets/probes';
import type { AddressFamily, ComparisonSeries } from '@/types/probe';
import type { ProbeId } from '@/types/probe-agent';

/**
 * GET /api/compare?targets=id,id,…&hours=… (or &start=…&end=…)[&maxPoints=…]
 *
 * The same window of several targets, bucketed on one shared grid so their
 * lines can be drawn on one chart — Smokeping's multi-host graph. A target
 * probed over both address families contributes two series, one per family,
 * which is also how a single dual-stack target compares IPv4 with IPv6.
 *
 * A target measured from several probes contributes the line of its primary
 * probe, as it always did. `probes=all` gives a line for each of its probes,
 * `split=probe` does the same, and `probe=<id>` moves every target that has
 * that probe to it. `series=<target>:<probe>,…` names each line exactly, which
 * is how a saved comparison is drawn.
 *
 * With `split=resolver`, a DNS target that asks several resolvers contributes
 * one series for each of them instead of one for all their queries together;
 * `family=4` or `family=6` with it keeps to the lookups made over that family.
 */
export async function GET(request: NextRequest) {
  try {
    await initializeServer();

    const { searchParams } = new URL(request.url);

    const window = windowFromQuery(searchParams);
    const startTime = new Date(window.start);
    const endTime = new Date(window.end);

    // Read from the database rather than trusted from the query: which targets
    // exist, which probes measure them, and which of them are split by family.
    const known = new Map((await getAllTargets()).map(target => [target.id, target]));

    // The lines asked for, before they are split by family or resolver.
    const lines: Array<{ targetId: string; probe: ProbeId }> = [];
    const named = (searchParams.get('series') ?? '').split(',').map(token => token.trim()).filter(Boolean);
    const listed = (searchParams.get('targets') ?? '').split(',').map(id => id.trim()).filter(Boolean);
    if (named.length === 0 && listed.length === 0) {
      return NextResponse.json({ error: 'No targets given' }, { status: 400 });
    }
    if (named.length > 0) {
      for (const token of named) {
        const colon = token.indexOf(':');
        const target = known.get(colon < 0 ? token : token.slice(0, colon));
        if (!target) continue;
        lines.push({ targetId: target.id, probe: chosenProbe(target, colon < 0 ? null : token.slice(colon + 1)) });
      }
    } else {
      const requested = listed.slice(0, MAX_COMPARED_TARGETS);
      const everyProbe = searchParams.get('probes') === 'all' || searchParams.get('split') === 'probe';
      const onlyProbe = searchParams.get('probe');

      for (const targetId of requested) {
        const target = known.get(targetId);
        if (!target) continue;
        if (everyProbe) {
          for (const probe of probeIdsOf(target)) lines.push({ targetId, probe });
        } else if (onlyProbe) {
          // Moved to that probe, for the monitors that have it.
          if (knownProbeIdsOf(target).includes(onlyProbe)) lines.push({ targetId, probe: onlyProbe });
        } else {
          lines.push({ targetId, probe: chosenProbe(target, null) });
        }
      }
    }

    const byResolver = searchParams.get('split') === 'resolver';
    // A target on both families asks its resolvers for a different record over
    // each, so their lines are for one family or the other.
    const familyParam = searchParams.get('family');
    const ofFamily: AddressFamily | null = familyParam === '4' ? 4 : familyParam === '6' ? 6 : null;
    const resolverLines: Promise<ComparisonSeries[]>[] = [];

    const wanted: Array<{ targetId: string; probe: ProbeId; family: AddressFamily | null }> = [];
    for (const { targetId, probe } of lines.slice(0, MAX_COMPARED_TARGETS)) {
      const target = known.get(targetId)!;

      const resolvers = target.probeType === 'dns' ? target.probeConfig?.resolvers ?? [] : [];
      if (byResolver && resolvers.length > 0) {
        resolverLines.push(
          getResolverRounds(targetId, startTime, endTime, { family: ofFamily ?? undefined, probe }).then(rounds =>
            resolverSeries(targetId, rounds, window.bucketMs, resolvers).map(line => ({
              targetId,
              probe,
              family: ofFamily,
              resolver: line.label,
              buckets: line.buckets,
              statistics: line.statistics,
            }))
          )
        );
      } else if (isDualStack(target.host, target.ipVersion)) {
        wanted.push({ targetId, probe, family: 4 }, { targetId, probe, family: 6 });
      } else {
        wanted.push({ targetId, probe, family: null });
      }
    }

    const series: ComparisonSeries[] = [
      ...(await Promise.all(
        wanted.map(async ({ targetId, probe, family }) => {
          const scope = { probe, family: family ?? undefined };
          const [buckets, statistics] = await Promise.all([
            getBucketedMeasurements(targetId, startTime, endTime, window.bucketMs, scope),
            getTargetStatistics(targetId, startTime, endTime, scope),
          ]);
          return { targetId, probe, family, buckets, statistics };
        })
      )),
      ...(await Promise.all(resolverLines)).flat(),
    ];

    return NextResponse.json({
      series,
      bucketMs: window.bucketMs,
      start: window.start,
      end: window.end,
    });
  } catch (error) {
    console.error('Error fetching comparison:', error);
    return NextResponse.json({ error: 'Failed to fetch comparison' }, { status: 500 });
  }
}
