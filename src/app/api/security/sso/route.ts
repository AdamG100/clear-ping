import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/security/http';
import { getSsoConfig, publicSsoConfig, saveSsoConfig, SSO_CALLBACK_PATH, type SsoConfig } from '@/lib/security/oidc';
import { recordActivity } from '@/lib/security/store';

/**
 * PUT /api/security/sso - Set up single sign-on
 * Body: any of { enabled, label, issuer, clientId, clientSecret, allowedGroup, autoCreate }
 *
 * The client secret is only ever written: an empty one keeps what is saved,
 * and it is never sent back. The redirect URI is taken from the address the
 * dashboard was opened at, which is the one the provider has to send people
 * back to, and saved with the rest.
 */
export async function PUT(request: NextRequest) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const body = (await request.json().catch(() => null)) as Partial<SsoConfig> | null;
  if (!body) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });

  const origin = request.headers.get('origin');
  const before = await getSsoConfig();
  try {
    const saved = await saveSsoConfig({
      ...body,
      ...(origin ? { redirectUri: `${origin}${SSO_CALLBACK_PATH}` } : {}),
    });
    if (before.enabled !== saved.enabled) {
      await recordActivity(user, 'dashboard', saved.enabled ? 'security.on' : 'security.off', `Single sign-on with ${saved.label}`);
    } else {
      await recordActivity(user, 'dashboard', 'sso.change', saved.label);
    }
    return NextResponse.json({ sso: publicSsoConfig(saved) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not save' }, { status: 400 });
  }
}
