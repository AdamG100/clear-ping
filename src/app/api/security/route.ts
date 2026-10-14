import { NextRequest, NextResponse } from 'next/server';
import { securityPolicy } from '@/lib/security/access';
import { requireAdmin, requireUser } from '@/lib/security/http';
import { getSsoConfig, publicSsoConfig, ssoUsable } from '@/lib/security/oidc';
import { describeOwed, factorsOwed, isFactorPolicy, REQUIREMENT_LABEL, type FactorPolicy } from '@/lib/security/factors';
import { canAdminister } from '@/lib/security/roles';
import {
  getFactorPolicy,
  getSecuritySettings,
  getUser,
  listApiKeys,
  listUsers,
  recordActivity,
  setFactorPolicy,
  setSecuritySettings,
  signedIn,
} from '@/lib/security/store';

/**
 * GET /api/security - Everything Settings shows the account signed in
 *
 * An admin is shown everything: the switches as set and as in force (an
 * environment variable can override them), every account, every key, the
 * single sign-on settings. Anyone else, their own account and their own keys,
 * and only as much of single sign-on as linking their account takes. Never a
 * key itself: those are shown once, when made.
 */
export async function GET(request: NextRequest) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const admin = canAdminister(user.role);
  const [settings, policy, users, keys, sso, factorPolicy] = await Promise.all([
    getSecuritySettings(),
    securityPolicy(),
    listUsers(),
    listApiKeys(admin ? undefined : user.id),
    getSsoConfig(),
    getFactorPolicy(),
  ]);
  const me = users.find(each => each.id === user.id);
  return NextResponse.json({
    me: { id: user.id, username: user.name, ...(me ?? {}), role: user.role },
    settings,
    factorPolicy,
    inForce: { loginRequired: policy.loginRequired, mcpKeyRequired: policy.mcpKeyRequired },
    environment: { recovery: policy.recovery, legacyMcpToken: policy.legacyMcpToken !== null },
    users: admin ? users : me ? [me] : [],
    keys,
    sso: admin
      ? publicSsoConfig(sso)
      : { enabled: ssoUsable(sso), label: sso.label },
  });
}

/**
 * PUT /api/security - Turn sign-in, keys for the MCP address, or password sign-in on or off
 * Body: { loginRequired?: boolean, mcpKeyRequired?: boolean, passwordLogin?: boolean,
 *         factorPolicy?: { require: 'none' | 'either' | 'totp' | 'passkey' | 'both', appliesTo: 'everyone' | 'others' } }
 *
 * `factorPolicy` is the second factors required of accounts that sign in to
 * ClearPing itself (factors.ts). Admins only.
 */
export async function PUT(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => null);
  const changes: { loginRequired?: boolean; mcpKeyRequired?: boolean; passwordLogin?: boolean } = {};
  for (const name of ['loginRequired', 'mcpKeyRequired', 'passwordLogin'] as const) {
    if (typeof body?.[name] === 'boolean') changes[name] = body[name];
  }

  if (body?.factorPolicy !== undefined) {
    if (!isFactorPolicy(body.factorPolicy)) {
      return NextResponse.json({ error: 'factorPolicy is { require, appliesTo }' }, { status: 400 });
    }
    const next: FactorPolicy = { require: body.factorPolicy.require, appliesTo: body.factorPolicy.appliesTo };
    // Never a rule the admin setting it does not meet: they would be sent
    // straight to add what they may not be able to add here (a passkey, at an
    // address passkeys do not work at), with Settings out of reach.
    const [session, me] = await Promise.all([signedIn(request.headers), getUser(user.id)]);
    const owed = me && factorsOwed(next, { role: me.role, totp: me.twoFactor, passkeys: me.passkeys }, { viaSso: session?.viaSso ?? false });
    if (owed) {
      return NextResponse.json({ error: `${describeOwed(owed)} before requiring it: it would apply to you too.` }, { status: 400 });
    }
    await setFactorPolicy(next);
    await recordActivity(
      user,
      'dashboard',
      'security.factors',
      next.require === 'none'
        ? 'No second factor required'
        : `${REQUIREMENT_LABEL[next.require]}, required of ${next.appliesTo === 'others' ? 'every account but the admins' : 'every account'}`
    );
    if (Object.keys(changes).length === 0) return NextResponse.json({ factorPolicy: next });
  }

  if (Object.keys(changes).length === 0) {
    return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });
  }
  // Single sign-on as the only way in, only while it works for the person
  // turning the rest off: otherwise this is how they lock themselves out.
  if (changes.passwordLogin === false) {
    const [sso, me] = await Promise.all([getSsoConfig(), getUser(user.id)]);
    if (!ssoUsable(sso)) {
      return NextResponse.json({ error: 'Set up single sign-on before turning password sign-in off' }, { status: 400 });
    }
    if (!me?.sso) {
      return NextResponse.json({ error: `Link your own account to ${sso.label} before turning password sign-in off` }, { status: 400 });
    }
  }

  const before = await getSecuritySettings();
  const settings = await setSecuritySettings(changes);
  const said = {
    loginRequired: 'Sign-in for the dashboard and API',
    mcpKeyRequired: 'Keys for the MCP address',
    passwordLogin: 'Signing in with a password',
  };
  for (const name of Object.keys(changes) as Array<keyof typeof changes>) {
    if (before[name] !== settings[name]) {
      await recordActivity(user, 'dashboard', settings[name] ? 'security.on' : 'security.off', said[name]);
    }
  }
  return NextResponse.json({ settings });
}
