import { NextRequest, NextResponse } from 'next/server';
import { deleteAlertRule, ensureAlertSchema, setAlertRuleEnabled } from '@/lib/alerts';
import { initializeServer } from '@/lib/init';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  try {
    await initializeServer();
    await ensureAlertSchema();

    const { ruleId } = await params;
    const body = await request.json();

    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }

    if (!(await setAlertRuleEnabled(ruleId, body.enabled))) {
      return NextResponse.json({ error: 'Alert rule not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating alert rule:', error);
    return NextResponse.json({ error: 'Failed to update alert rule' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  try {
    await initializeServer();
    await ensureAlertSchema();

    const { ruleId } = await params;
    if (!(await deleteAlertRule(ruleId))) {
      return NextResponse.json({ error: 'Alert rule not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting alert rule:', error);
    return NextResponse.json({ error: 'Failed to delete alert rule' }, { status: 500 });
  }
}
