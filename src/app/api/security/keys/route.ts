import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/security/http';
import { maxKeyAccess, ROLE_LABEL } from '@/lib/security/roles';
import { createApiKey, recordActivity, type KeyAccess } from '@/lib/security/store';

/**
 * POST /api/security/keys - Create a key for a script or an assistant
 * Body: { name: string, access: 'read' | 'write' }
 *
 * Any account may make keys, as its own: a key can never do more than the
 * account that made it, so a viewer's keys only read. The key is in the
 * answer and nowhere else, ever: only a hash of it is kept.
 */
export async function POST(request: NextRequest) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const access: KeyAccess | null = body?.access === 'read' || body?.access === 'write' ? body.access : null;

  if (!name || name.length > 60) {
    return NextResponse.json({ error: 'Give the key a name of up to 60 characters, such as the assistant it is for' }, { status: 400 });
  }
  if (!access) return NextResponse.json({ error: 'Say whether the key may only read, or read and write' }, { status: 400 });
  if (access === 'write' && maxKeyAccess(user.role) === 'read') {
    return NextResponse.json(
      { error: `Your account is a ${ROLE_LABEL[user.role]}, so its keys can only read` },
      { status: 403 }
    );
  }

  const { key, record } = await createApiKey(name, access, { id: user.id, name: user.name });
  await recordActivity(user, 'dashboard', 'key.create', `${name} (${access === 'write' ? 'read and write' : 'read only'})`);
  return NextResponse.json({ key, record }, { status: 201 });
}
