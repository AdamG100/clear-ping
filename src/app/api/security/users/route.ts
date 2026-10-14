import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/security/http';
import { passwordProblem } from '@/lib/security/secrets';
import { createUser, recordActivity } from '@/lib/security/store';

/**
 * POST /api/security/users - Add an account
 * Body: { username, password }
 *
 * Every account can do everything, the security settings included.
 */
export async function POST(request: NextRequest) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => null);
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const problem = passwordProblem(body?.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  try {
    const created = await createUser(username, body.password);
    await recordActivity(user, 'dashboard', 'account.add', created.username);
    return NextResponse.json({ user: created }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not add the account' }, { status: 400 });
  }
}
