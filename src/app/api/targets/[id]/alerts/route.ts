import { NextRequest, NextResponse } from 'next/server';
import { createAlertRule, ensureAlertSchema, getAlertRules } from '@/lib/alerts';
import { getTargetById } from '@/lib/database';
import { initializeServer } from '@/lib/init';
import type { AlertMetric } from '@/types/probe';

const METRICS: AlertMetric[] = ['packetLoss', 'latency', 'jitter', 'unreachable'];

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initializeServer();
    await ensureAlertSchema();
    const { id } = await params;
    return NextResponse.json({ rules: await getAlertRules(id) });
  } catch (error) {
    console.error('Error fetching alert rules:', error);
    return NextResponse.json({ error: 'Failed to fetch alert rules' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initializeServer();
    await ensureAlertSchema();

    const { id } = await params;
    if (!(await getTargetById(id))) {
      return NextResponse.json({ error: 'Target not found' }, { status: 404 });
    }

    const body = await request.json();
    const metric = body.metric as AlertMetric;

    if (!METRICS.includes(metric)) {
      return NextResponse.json({ error: `Invalid metric. Expected one of: ${METRICS.join(', ')}` }, { status: 400 });
    }

    // 'unreachable' has no threshold to compare against; everything else does.
    const threshold = metric === 'unreachable' ? 0 : Number(body.threshold);
    if (metric !== 'unreachable' && (!Number.isFinite(threshold) || threshold < 0)) {
      return NextResponse.json({ error: 'Threshold must be a non-negative number' }, { status: 400 });
    }

    const consecutiveProbes = Number(body.consecutiveProbes ?? 3);
    if (!Number.isInteger(consecutiveProbes) || consecutiveProbes < 1 || consecutiveProbes > 100) {
      return NextResponse.json({ error: 'consecutiveProbes must be between 1 and 100' }, { status: 400 });
    }

    const webhookUrl = typeof body.webhookUrl === 'string' && body.webhookUrl.trim()
      ? body.webhookUrl.trim()
      : undefined;

    if (webhookUrl && !/^https?:\/\//i.test(webhookUrl)) {
      return NextResponse.json({ error: 'Webhook URL must start with http:// or https://' }, { status: 400 });
    }

    const rule = await createAlertRule({ targetId: id, metric, threshold, consecutiveProbes, webhookUrl });
    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    console.error('Error creating alert rule:', error);
    return NextResponse.json({ error: 'Failed to create alert rule' }, { status: 500 });
  }
}
