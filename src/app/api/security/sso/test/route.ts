import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/http';
import { discover } from '@/lib/security/oidc';

/**
 * POST /api/security/sso/test - Can the provider be reached at this issuer?
 * Body: { issuer }
 *
 * Reads its OpenID configuration, as signing in would, and says what it
 * found or why it could not. Nothing is saved.
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => null);
  const issuer = typeof body?.issuer === 'string' ? body.issuer.trim() : '';
  if (!issuer) return NextResponse.json({ error: 'Give the issuer to test' }, { status: 400 });

  try {
    const found = await discover(issuer, fetch, true);
    return NextResponse.json({
      ok: true,
      issuer: found.issuer,
      authorization: found.authorization_endpoint,
      token: found.token_endpoint,
      signOut: found.end_session_endpoint ?? null,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Could not reach it' }, { status: 200 });
  }
}
