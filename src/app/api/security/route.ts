import { NextRequest, NextResponse } from 'next/server';
import { securityPolicy } from '@/lib/security/access';
import { requireUser } from '@/lib/security/http';
import { getSecuritySettings, listApiKeys, listUsers, recordActivity, setSecuritySettings } from '@/lib/security/store';

/**
 * GET /api/security - Everything the security settings show
 *
 * The switches as set and as in force (an environment variable can override
 * them), the accounts, and the keys. Never a key itself: those are shown once,
 * when made.
 */
export async function GET(request: NextRequest) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const [settings, policy, users, keys] = await Promise.all([getSecuritySettings(), securityPolicy(), listUsers(), listApiKeys()]);
  return NextResponse.json({
    me: { id: user.id, username: user.name },
    settings,
    inForce: { loginRequired: policy.loginRequired, mcpKeyRequired: policy.mcpKeyRequired },
    environment: { recovery: policy.recovery, legacyMcpToken: policy.legacyMcpToken !== null },
    users,
    keys,
  });
}

/**
 * PUT /api/security - Turn sign-in, or keys for the MCP address, on or off
 * Body: { loginRequired?: boolean, mcpKeyRequired?: boolean }
 */
export async function PUT(request: NextRequest) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => null);
  const changes: { loginRequired?: boolean; mcpKeyRequired?: boolean } = {};
  for (const name of ['loginRequired', 'mcpKeyRequired'] as const) {
    if (typeof body?.[name] === 'boolean') changes[name] = body[name];
  }
  if (Object.keys(changes).length === 0) {
    return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });
  }

  const before = await getSecuritySettings();
  const settings = await setSecuritySettings(changes);
  const said = { loginRequired: 'Sign-in for the dashboard and API', mcpKeyRequired: 'Keys for the MCP address' };
  for (const name of Object.keys(changes) as Array<keyof typeof changes>) {
    if (before[name] !== settings[name]) {
      await recordActivity(user, 'dashboard', settings[name] ? 'security.on' : 'security.off', said[name]);
    }
  }
  return NextResponse.json({ settings });
}
