import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/http';
import { getUser, makePasswordLink, recordActivity } from '@/lib/security/store';

/**
 * POST /api/security/users/:id/link - A one-time link for the account's owner to choose a password
 *
 * Admins only, as with setting a password for them, but the admin never
 * learns it. The answer carries the token (shown this once; the page makes
 * the address of it), good for PASSWORD_LINK_HOURS; a new one replaces any
 * before it. Not your own account and not the primary one.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  if (id === user.id) {
    return NextResponse.json({ error: 'Change your own password under Your account, with your current one' }, { status: 400 });
  }

  try {
    const link = await makePasswordLink(id);
    const account = await getUser(id);
    await recordActivity(user, 'dashboard', 'account.password.link', account?.username ?? id);
    return NextResponse.json({ link });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not make the link';
    return NextResponse.json({ error: message }, { status: /no such account/i.test(message) ? 404 : 400 });
  }
}
