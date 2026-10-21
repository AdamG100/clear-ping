import { NextRequest, NextResponse } from 'next/server';
import { devUserEnabled, signInDevUser } from '@/lib/security/dev-user';
import { passCookies } from '@/lib/security/http';
import { safeNext } from '@/lib/security/oidc';

/**
 * GET /api/auth/dev-user?next=/path - Sign in as the dev account, then go on
 *
 * Only under `next dev` (see dev-user.ts), where the proxy sends a page opened
 * without a session here. When it cannot sign in, the sign-in page instead,
 * which the proxy never sends back here, so there is no loop.
 */
export async function GET(request: NextRequest) {
  if (!devUserEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const next = safeNext(request.nextUrl.searchParams.get('next'));
  const answer = await signInDevUser(request.headers);
  if (!answer) {
    return new NextResponse(null, { status: 303, headers: { Location: `/login?next=${encodeURIComponent(next)}` } });
  }
  return passCookies(answer, new NextResponse(null, { status: 303, headers: { Location: next } }), request);
}
