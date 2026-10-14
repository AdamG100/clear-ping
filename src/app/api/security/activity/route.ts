import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/http';
import { listActivity } from '@/lib/security/store';

/**
 * GET /api/security/activity?limit=100&before=<id> - Who changed what, newest first
 *
 * Changes made from the dashboard, through the API and by assistants over
 * MCP, each with the account or key that made it; and sign-ins, failed ones
 * included. `before` pages back from the oldest entry already shown.
 */
export async function GET(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  const { searchParams } = new URL(request.url);
  const limit = Math.min(500, Math.max(1, Number(searchParams.get('limit')) || 100));
  const before = Number(searchParams.get('before')) || undefined;
  return NextResponse.json({ entries: await listActivity(limit, before) });
}
