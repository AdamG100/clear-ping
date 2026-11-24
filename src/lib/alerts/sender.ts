import { getJsonSetting, setJsonSetting } from '@/lib/security/settings-store';

/**
 * Who a notification is posted as: the name and the picture a chat shows
 * beside it, set under Settings, Notifications. Discord (and Guilded) take
 * both from each message; a service that does not keeps its own.
 *
 * Either may be left out, and then the service's own is used: the name the
 * webhook was given, and Apprise's picture for a failure or a success.
 */
export interface NotificationSender {
  name: string | null;
  avatarUrl: string | null;
}

const KEY = 'notifications.sender';
const NAME_MAX = 80;
const URL_MAX = 2048;

export const NO_SENDER: NotificationSender = { name: null, avatarUrl: null };

/**
 * A sender from what was sent, or the reason it will not do.
 *
 * Discord refuses a webhook name with "discord" or "clyde" in it, and takes
 * a picture only from a web address it can fetch.
 */
export function readSender(input: unknown): NotificationSender | { error: string } {
  const body = (input ?? {}) as { name?: unknown; avatarUrl?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const avatarUrl = typeof body.avatarUrl === 'string' ? body.avatarUrl.trim() : '';

  if (name.length > NAME_MAX) return { error: `Keep the name to ${NAME_MAX} characters` };
  if (/discord|clyde/i.test(name)) return { error: 'Discord does not allow "discord" or "clyde" in the name' };
  if (/[@#:]|```/.test(name)) return { error: 'Leave @, #, : and ``` out of the name: Discord refuses them' };

  if (avatarUrl) {
    let url: URL;
    try {
      url = new URL(avatarUrl);
    } catch {
      return { error: 'Give the picture as a web address, such as https://example.com/logo.png' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'Give the picture as an http or https address' };
    if (avatarUrl.length > URL_MAX) return { error: 'That picture address is too long' };
  }

  return { name: name || null, avatarUrl: avatarUrl || null };
}

export async function getNotificationSender(): Promise<NotificationSender> {
  const read = readSender(await getJsonSetting(KEY));
  return 'error' in read ? NO_SENDER : read;
}

export async function setNotificationSender(sender: NotificationSender): Promise<void> {
  await setJsonSetting(KEY, sender);
}
