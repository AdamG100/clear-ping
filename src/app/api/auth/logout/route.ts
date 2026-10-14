import { NextRequest, NextResponse } from 'next/server';
import { readCookie } from '@/lib/security/access';
import { clearSessionCookie } from '@/lib/security/http';
import { endSession, SESSION_COOKIE } from '@/lib/security/store';

/** POST /api/auth/logout - Sign out: the session is ended on the server, not only forgotten by the browser. */
export async function POST(request: NextRequest) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (token) await endSession(token);

  const response = NextResponse.json({ success: true });
  clearSessionCookie(response, request);
  return response;
}
