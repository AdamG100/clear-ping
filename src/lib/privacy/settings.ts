import { getJsonSetting, setJsonSetting } from '../security/settings-store'
import { DEFAULT_PRIVACY, holdPrivacy, KEEP_ACTIVITY_CHOICES, privacyNow, type PrivacySettings } from './current'

export { DEFAULT_PRIVACY, KEEP_ACTIVITY_CHOICES, privacyNow, signInDetail, type HideAddresses, type PrivacySettings } from './current'

/**
 * Settings → Privacy: what ClearPing shows, hands on, keeps and asks for.
 *
 * Stored with the other settings; what is in force is held in memory too
 * (current.ts), for code that cannot wait on the database.
 */

const KEY = 'privacy.settings'

export async function getPrivacySettings(): Promise<PrivacySettings> {
  const stored = await getJsonSetting<Partial<PrivacySettings>>(KEY).catch(() => null)
  const settings = { ...DEFAULT_PRIVACY, ...(stored ?? {}) }
  holdPrivacy(settings)
  return settings
}

/** Checked field by field: whatever is not valid is refused, not quietly changed. */
export function parsePrivacySettings(input: unknown): { ok: true; settings: PrivacySettings } | { ok: false; error: string } {
  const body = (input ?? {}) as Record<string, unknown>
  if (body.hideAddresses !== 'off' && body.hideAddresses !== 'viewers' && body.hideAddresses !== 'everyone') {
    return { ok: false, error: 'Hide addresses is off, for viewers or for everyone' }
  }
  for (const key of ['hideFromAssistants', 'recordSignInAddresses', 'checkForUpdates'] as const) {
    if (typeof body[key] !== 'boolean') return { ok: false, error: `Say whether ${key} is on` }
  }
  if (!(KEEP_ACTIVITY_CHOICES as readonly unknown[]).includes(body.keepActivityDays)) {
    return { ok: false, error: `Activity is kept for ${KEEP_ACTIVITY_CHOICES.join(', ')} days` }
  }
  return {
    ok: true,
    settings: {
      hideAddresses: body.hideAddresses,
      hideFromAssistants: body.hideFromAssistants as boolean,
      recordSignInAddresses: body.recordSignInAddresses as boolean,
      keepActivityDays: body.keepActivityDays as number,
      checkForUpdates: body.checkForUpdates as boolean,
      // Added after the others: a client from before it leaves it as it is.
      lookUpNetworks: typeof body.lookUpNetworks === 'boolean' ? body.lookUpNetworks : privacyNow().lookUpNetworks,
    },
  }
}

export async function savePrivacySettings(settings: PrivacySettings): Promise<PrivacySettings> {
  await setJsonSetting(KEY, settings)
  holdPrivacy(settings)
  return settings
}
