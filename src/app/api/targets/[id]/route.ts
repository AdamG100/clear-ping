import { NextRequest, NextResponse } from 'next/server';
import { getTargetById, updateTarget, deleteTarget } from '@/lib/database';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
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
    const { id } = await params;
    const body = await request.json();

    const updated = await updateTarget(id, body);

    if (!updated) {
      return NextResponse.json(
        { error: 'Target not found' },
        { status: 404 }
      );
    }

    const target = await getTargetById(id);
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
    const { id } = await params;
    const deleted = await deleteTarget(id);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Target not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting target:', error);
    return NextResponse.json(
      { error: 'Failed to delete target' },
      { status: 500 }
    );
  }
}
