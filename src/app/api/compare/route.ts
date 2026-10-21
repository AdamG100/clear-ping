import { NextRequest, NextResponse } from 'next/server';
import { getAllTargets, getBucketedMeasurements, getResolverRounds, getTargetStatistics } from '@/lib/db/database';
import { resolverSeries } from '@/lib/charts/dns-resolver-series';
import { isDualStack } from '@/lib/probes/host';
import { initializeServer } from '@/lib/init';
import { windowFromQuery } from '@/lib/charts/series';
import type { AddressFamily, ComparisonSeries } from '@/types/probe';

/** More lines than this on one chart cannot be told apart. */
const MAX_TARGETS = 24;

/**
 * GET /api/compare?targets=id,id,…&hours=… (or &start=…&end=…)
 *
 * The same window of several targets, bucketed on one shared grid so their
 * lines can be drawn on one chart — Smokeping's multi-host graph. A target
 * probed over both address families contributes two series, one per family,
 * which is also how a single dual-stack target compares IPv4 with IPv6.
 *
 * With `split=resolver`, a DNS target that asks several resolvers contributes
 * one series for each of them instead of one for all their queries together;
 * `family=4` or `family=6` with it keeps to the lookups made over that family.
 */
export async function GET(request: NextRequest) {
  try {
    await initializeServer();

    const { searchParams } = new URL(request.url);
    const requested = (searchParams.get('targets') ?? '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean)
      .slice(0, MAX_TARGETS);

    if (requested.length === 0) {
      return NextResponse.json({ error: 'No targets given' }, { status: 400 });
    }

    const window = windowFromQuery(searchParams);
    const startTime = new Date(window.start);
    const endTime = new Date(window.end);

    // Read from the database rather than trusted from the query: which targets
    // exist, and which of them are split by family.
    const known = new Map((await getAllTargets()).map(target => [target.id, target]));

    const byResolver = searchParams.get('split') === 'resolver';
    // A target on both families asks its resolvers for a different record over
    // each, so their lines are for one family or the other.
    const familyParam = searchParams.get('family');
    const ofFamily: AddressFamily | null = familyParam === '4' ? 4 : familyParam === '6' ? 6 : null;
    const resolverLines: Promise<ComparisonSeries[]>[] = [];

    const wanted: Array<{ targetId: string; family: AddressFamily | null }> = [];
    for (const targetId of requested) {
      const target = known.get(targetId);
      if (!target) continue;

      const resolvers = target.probeType === 'dns' ? target.probeConfig?.resolvers ?? [] : [];
      if (byResolver && resolvers.length > 0) {
        resolverLines.push(
          getResolverRounds(targetId, startTime, endTime, ofFamily ?? undefined).then(rounds =>
            resolverSeries(targetId, rounds, window.bucketMs, resolvers).map(line => ({
              targetId,
              family: ofFamily,
              resolver: line.label,
              buckets: line.buckets,
              statistics: line.statistics,
            }))
          )
        );
      } else if (isDualStack(target.host, target.ipVersion)) {
        wanted.push({ targetId, family: 4 }, { targetId, family: 6 });
      } else {
        wanted.push({ targetId, family: null });
      }
    }

    const series: ComparisonSeries[] = [
      ...(await Promise.all(
        wanted.map(async ({ targetId, family }) => {
          const [buckets, statistics] = await Promise.all([
            getBucketedMeasurements(targetId, startTime, endTime, window.bucketMs, family ?? undefined),
            getTargetStatistics(targetId, startTime, endTime, family ?? undefined),
          ]);
          return { targetId, family, buckets, statistics };
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
