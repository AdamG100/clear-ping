import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { getPrivacySettings, parsePrivacySettings, savePrivacySettings, type PrivacySettings } from '@/lib/privacy/settings';
import { actorFor, identify } from '@/lib/security/access';
import { requireAdmin } from '@/lib/security/http';
import { canChange } from '@/lib/security/roles';
import { recordActivity } from '@/lib/security/store';

/**
 * Settings → Privacy. Anyone who can open the dashboard reads whether
 * addresses are hidden from them, since every page needs to know; only an
 * admin changes the settings.
 */

/** Whether whoever asked sees addresses hidden: everyone, or anyone who may only look. */
async function hiddenFor(request: NextRequest, settings: PrivacySettings): Promise<boolean> {
  if (settings.hideAddresses === 'everyone') return true;
  if (settings.hideAddresses === 'off') return false;
  const { actor } = await identify(request);
  return !(actor?.kind === 'user' && canChange(actor.role));
}

async function answer(request: NextRequest, settings: PrivacySettings) {
  const retention = Number(process.env.CLEARPING_RETENTION_DAYS ?? 90);
  return NextResponse.json({
    settings,
    hideAddresses: await hiddenFor(request, settings),
    // Set where ClearPing runs, not here: shown so the page can say how long readings are kept.
    readingsKeptDays: Number.isFinite(retention) && retention > 0 ? retention : null,
  });
}

/** GET /api/privacy - The settings, and whether addresses are hidden from whoever asked */
export async function GET(request: NextRequest) {
  try {
    await initializeServer();
    return answer(request, await getPrivacySettings());
  } catch (error) {
    console.error('Error reading the privacy settings:', error);
    return NextResponse.json({ error: 'Failed to read the privacy settings' }, { status: 500 });
  }
}

/**
 * PUT /api/privacy - Change them
 * Body: { hideAddresses, hideFromAssistants, recordSignInAddresses, keepActivityDays, checkForUpdates, lookUpNetworks }
 */
export async function PUT(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  try {
    await initializeServer();
    const parsed = parsePrivacySettings(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const saved = await savePrivacySettings(parsed.settings);
    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'privacy.settings');
    return answer(request, saved);
  } catch (error) {
    console.error('Error saving the privacy settings:', error);
    return NextResponse.json({ error: 'Failed to save the privacy settings' }, { status: 500 });
  }
}
