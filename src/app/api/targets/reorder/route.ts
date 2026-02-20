import { NextRequest, NextResponse } from 'next/server';
import { getGroupOrders, saveGroupOrders, updateTargetSortOrders } from '@/lib/database';

/**
 * GET /api/targets/reorder - Get current group ordering
 */
export async function GET() {
  try {
    const orders = await getGroupOrders();
    return NextResponse.json({ orders });
  } catch (error) {
    console.error('Error fetching group orders:', error);
    return NextResponse.json(
      { error: 'Failed to fetch group orders' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/targets/reorder - Save group ordering and/or target ordering
 * Body: { groups?: { groupName: string, sortOrder: number }[], targets?: { id: string, sortOrder: number, group?: string }[] }
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { groups, targets } = body;

    if (groups && Array.isArray(groups)) {
      await saveGroupOrders(groups);
    }

    if (targets && Array.isArray(targets)) {
      await updateTargetSortOrders(targets);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error saving ordering:', error);
    return NextResponse.json(
      { error: 'Failed to save ordering' },
      { status: 500 }
    );
  }
}
