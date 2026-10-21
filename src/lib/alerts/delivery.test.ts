import { describe, expect, it } from 'vitest'
import type { AlertEvent } from '@/types/probe'
import {
  alertTitle,
  describeCondition,
  notificationFor,
  notifyUrlLabel,
  parseNotifyUrls,
  redactNotifyUrl,
  restoreRedacted,
  withEmbeds,
} from './delivery'

function event(over: Partial<AlertEvent> = {}, rule: Partial<AlertEvent['rule']> = {}): AlertEvent {
  return {
    rule: {
      id: 'alert-1',
      targetId: 'target-1',
      metric: 'packetLoss',
      threshold: 5,
      consecutiveProbes: 3,
      notifyUrls: ['discord://123456789012345678/token'],
      traceOnFire: true,
      traceCooldownMinutes: 15,
      enabled: true,
      state: 'firing',
      streak: 0,
      createdAt: new Date(0),
      ...rule,
    },
    targetName: 'Router',
    targetHost: '192.0.2.1',
    targetGroup: 'Home/Network',
    transition: 'firing',
    metric: 'packetLoss',
    observed: 42.53,
    threshold: 5,
    at: new Date('2026-08-19T22:41:43.911Z'),
    ...over,
  }
}

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

describe('notificationFor', () => {
  it('words a firing alert as a failure, with what is wrong in the title', () => {
    expect(notificationFor(event(), { zone: 'UTC' })).toEqual({
      title: 'Router: packet loss is too high',
      body:
        '<p><b>Packet loss above 5%</b> for 3 probes in a row.</p>' +
        '<ul>' +
        '<li><b>Address:</b> 192.0.2.1</li>' +
        '<li><b>Now:</b> 42.5%</li>' +
        '<li><b>When:</b> 2026-08-19 22:41:43 UTC</li>' +
        '<li><b>Alert:</b> Packet loss above 5%</li>' +
        '<li><b>Group:</b> Home / Network</li>' +
        '</ul>',
      type: 'failure',
    })
  })

  it('words a recovery as a success', () => {
    const notification = notificationFor(event({ transition: 'resolved', observed: 0 }))

    expect(notification.title).toBe('Router has recovered')
    expect(notification.body).toContain('<p><b>Packet loss above 5%</b> has been clear for 3 probes in a row.</p>')
    expect(notification.type).toBe('success')
  })

  it('says what a target that is down is doing, not a number', () => {
    const notification = notificationFor(
      event({ metric: 'unreachable', observed: 1 }, { metric: 'unreachable', threshold: 0, consecutiveProbes: 1 })
    )
    expect(notification.title).toBe('Router is not responding')
    expect(notification.body).toContain('<p><b>Stops responding</b> on the latest probe.</p>')
    expect(notification.body).toContain('<li><b>Now:</b> No reply</li>')
  })

  it('uses the name of a named alert, and leaves out a group the target does not have', () => {
    const notification = notificationFor(event({ targetGroup: undefined }, { name: 'Uplink' }))
    expect(notification.body).toContain('<li><b>Alert:</b> Uplink</li>')
    expect(notification.body).not.toContain('Group')
  })

  it('keeps what a target or an alert is called from being read as markup', () => {
    const notification = notificationFor(
      event({ targetName: '<b>Core</b> & edge', targetHost: 'a&b.example' }, { name: '<script>x</script>' })
    )
    // The title is plain text: Apprise escapes it for whichever service it goes to.
    expect(notification.title).toBe('<b>Core</b> & edge: packet loss is too high')
    expect(notification.body).toContain('<li><b>Address:</b> a&amp;b.example</li>')
    expect(notification.body).toContain('<li><b>Alert:</b> &lt;script&gt;x&lt;/script&gt;</li>')
  })

  it('lets nothing a target is called notify a whole channel', () => {
    // A zero-width space after the @ reads the same and is no longer a mention.
    const notification = notificationFor(event({ targetName: '@everyone' }, { name: 'tell @here' }))
    expect(notification.title).toBe('@​everyone: packet loss is too high')
    expect(notification.body).toContain('<li><b>Alert:</b> tell @​here</li>')
    expect(notification.title + notification.body).not.toMatch(/@(everyone|here)/)
  })

  it('keeps the title within what a service will take', () => {
    expect(notificationFor(event({ targetName: 'x'.repeat(400) })).title.length).toBeLessThanOrEqual(250)
  })

  it('marks a test as a test', () => {
    expect(notificationFor(event(), { test: true }).title).toBe('Test: Router: packet loss is too high')
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
