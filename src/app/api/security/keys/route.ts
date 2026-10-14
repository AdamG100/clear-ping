import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/security/http';
import { createApiKey, recordActivity, type KeyAccess } from '@/lib/security/store';

/**
 * POST /api/security/keys - Make a key for a script or an assistant
 * Body: { name: string, access: 'read' | 'write' }
 *
 * The key is in the answer and nowhere else, ever: only a hash of it is kept.
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
  if (!access) return NextResponse.json({ error: 'Say whether the key may only read, or read and change' }, { status: 400 });

  const { key, record } = await createApiKey(name, access, user.name);
  await recordActivity(user, 'dashboard', 'key.create', `${name} (${access === 'write' ? 'read and change' : 'read only'})`);
  return NextResponse.json({ key, record }, { status: 201 });
}
