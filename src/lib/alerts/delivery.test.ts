import { describe, expect, it } from 'vitest'
import {
  alertAsShown,
  alertTitle,
  describeCondition,
  notifyUrlLabel,
  parseNotifyUrls,
  redactNotifyUrl,
  restoreRedacted,
  withEmbeds,
} from './delivery'

describe('parseNotifyUrls', () => {
  it('reads URLs on separate lines, or as a list', () => {
    expect(parseNotifyUrls('discord://1/abc\nmailto://user:pass@example.com\r\n')).toEqual([
      'discord://1/abc',
      'mailto://user:pass@example.com',
    ])
    expect(parseNotifyUrls(['tgram://token/chat', ' ntfy://topic '])).toEqual(['tgram://token/chat', 'ntfy://topic'])
  })

  it('takes a URL for any service, since which ones exist is for Apprise to say', () => {
    const urls = [
      'jsons://hooks.example.com/path?-token=abc&format=text',
      'discord://123/abc/?ping=%3C%40%26111%3E,%3C%40222%3E',
      'mailtos://user:p%40ss@mail.example.com?to=a@example.com,b@example.com',
      'https://hooks.slack.com/services/T000/B000/XXXX',
      'some-future-service://whatever',
    ]
    expect(parseNotifyUrls(urls.join('\n'))).toEqual(urls)
  })

  it('reads nothing as no URLs, and the same one twice as one', () => {
    expect(parseNotifyUrls('')).toEqual([])
    expect(parseNotifyUrls(' \n ')).toEqual([])
    expect(parseNotifyUrls(undefined)).toEqual([])
    expect(parseNotifyUrls([])).toEqual([])
    expect(parseNotifyUrls('ntfy://topic\nntfy://topic')).toEqual(['ntfy://topic'])
  })

  it('refuses anything that is not a URL, rather than dropping it', () => {
    expect(parseNotifyUrls('discord')).toBeNull()
    expect(parseNotifyUrls('discord://1/abc\nmy channel')).toBeNull()
    expect(parseNotifyUrls('://nothing')).toBeNull()
    expect(parseNotifyUrls(['discord://1/abc', 'has a space://x'])).toBeNull()
    expect(parseNotifyUrls(42)).toBeNull()
  })
})

describe('notifyUrlLabel', () => {
  it('names the service and gives away nothing else of the URL', () => {
    expect(notifyUrlLabel('discord://123456789012345678/secret-token')).toBe('discord')
    expect(notifyUrlLabel('MAILTOS://user:password@example.com')).toBe('mailtos')
  })

  it('names the host of a web address, which is what Apprise knows the service by', () => {
    expect(notifyUrlLabel('https://hooks.slack.com/services/T000/B000/XXXX')).toBe('hooks.slack.com')
    expect(notifyUrlLabel('https://discord.com/api/webhooks/123/secret')).toBe('discord.com')
  })
})

describe('redactNotifyUrl', () => {
  it('keeps the service and drops the tokens and passwords', () => {
    expect(redactNotifyUrl('discord://123456789012345678/secret-token')).toBe('discord://…')
    expect(redactNotifyUrl('mailtos://user:password@example.com')).toBe('mailtos://…')
    expect(redactNotifyUrl('https://hooks.slack.com/services/T000/B000/XXXX')).toBe('https://hooks.slack.com/…')
    expect(redactNotifyUrl('not a url')).toBe('…')
  })

  it('still names the same service once redacted', () => {
    for (const url of ['tgram://bot-token/chat-id', 'https://discord.com/api/webhooks/123/secret']) {
      expect(notifyUrlLabel(redactNotifyUrl(url))).toBe(notifyUrlLabel(url))
    }
  })
})

describe('describing an alert', () => {
  it('words each kind of condition', () => {
    expect(describeCondition({ metric: 'unreachable', threshold: 0 })).toBe('Stops responding')
    expect(describeCondition({ metric: 'packetLoss', threshold: 5 })).toBe('Packet loss above 5%')
    expect(describeCondition({ metric: 'latency', threshold: 200 })).toBe('Latency above 200ms')
    expect(describeCondition({ metric: 'certExpiry', threshold: 14 })).toBe('Certificate expires within 14 days')
  })

  it('calls an alert by its name when it has one', () => {
    expect(alertTitle({ name: 'Uplink', metric: 'packetLoss', threshold: 5 })).toBe('Uplink')
    expect(alertTitle({ name: '  ', metric: 'packetLoss', threshold: 5 })).toBe('Packet loss above 5%')
    expect(alertTitle({ metric: 'packetLoss', threshold: 5 })).toBe('Packet loss above 5%')
  })
})

describe('withEmbeds', () => {
  it('asks Apprise for an embed on Discord, by its own scheme or by a webhook address', () => {
    expect(withEmbeds('discord://123/abc')).toBe('discord://123/abc?format=markdown')
    expect(withEmbeds('discord://123/abc/?ping=%3C%40222%3E')).toBe('discord://123/abc/?ping=%3C%40222%3E&format=markdown')
    expect(withEmbeds('guilded://123/abc')).toBe('guilded://123/abc?format=markdown')
    expect(withEmbeds('https://discord.com/api/webhooks/123/abc')).toBe('https://discord.com/api/webhooks/123/abc?format=markdown')
    expect(withEmbeds('https://discordapp.com/api/webhooks/123/abc?thread_id=9'))
      .toBe('https://discordapp.com/api/webhooks/123/abc?thread_id=9&format=markdown')
  })

  it('leaves a URL that already says which format it wants', () => {
    expect(withEmbeds('discord://123/abc/?format=text')).toBe('discord://123/abc/?format=text')
    expect(withEmbeds('discord://123/abc/?format=markdown')).toBe('discord://123/abc/?format=markdown')
  })

  it('leaves every other service as it is', () => {
    for (const url of ['slack://T/B/C', 'https://hooks.slack.com/services/T/B/X', 'tgram://bot/chat', 'jsons://example.com/discord/x']) {
      expect(withEmbeds(url)).toBe(url)
    }
  })
})

describe('restoreRedacted', () => {
  const real = ['discord://1234/secret-token', 'https://hooks.example/abc/def']

  it('puts back the URL a redacted one was made from', () => {
    expect(restoreRedacted(real.map(redactNotifyUrl), real)).toEqual(real)
  })

  it('takes a URL that was typed as it is, and keeps one that is already whole', () => {
    expect(restoreRedacted(['tgram://new/token', real[0]], real)).toEqual(['tgram://new/token', real[0]])
  })
})

describe('alertAsShown', () => {
  const alert = { id: 'a1', notifyUrls: ['discord://1234/secret-token', 'mailto://me:hunter22@mail.example'] }

  it('shows the URLs whole to whoever may change alerts', () => {
    expect(alertAsShown(alert, true)).toBe(alert)
  })

  it('shows anyone else which service, and none of its secrets', () => {
    const shown = alertAsShown(alert, false)
    expect(shown.notifyUrls).toEqual(['discord://…', 'mailto://…'])
    expect(JSON.stringify(shown)).not.toMatch(/secret-token|hunter22/)
    expect(alert.notifyUrls[0]).toBe('discord://1234/secret-token')
  })
})
