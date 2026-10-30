import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/security/http';
import { parseKeyDays } from '@/lib/security/key-lifetime';
import { maxKeyAccess, ROLE_LABEL } from '@/lib/security/roles';
import { createApiKey, recordActivity, type KeyAccess } from '@/lib/security/store';

/**
 * POST /api/security/keys - Create a key for a script or an assistant
 * Body: { name: string, access: 'read' | 'write', expiresInDays?: number | null }
 *
 * `expiresInDays` is how many days the key works for (1 to 3650); left out or
 * null, it never stops.
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

  const lifetime = parseKeyDays(body?.expiresInDays);
  if ('error' in lifetime) return NextResponse.json({ error: lifetime.error }, { status: 400 });

  const { key, record } = await createApiKey(name, access, { id: user.id, name: user.name }, lifetime.days);
  await recordActivity(
    user,
    'dashboard',
    'key.create',
    `${name} (${access === 'write' ? 'read and write' : 'read only'}, ${lifetime.days ? `lasts ${lifetime.days} ${lifetime.days === 1 ? 'day' : 'days'}` : 'no expiry'})`
  );
  return NextResponse.json({ key, record }, { status: 201 });
}
