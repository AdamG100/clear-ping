import { describe, expect, it } from 'vitest'
import type { AlertEvent } from '@/types/probe'
import { alertNotification, notificationFor, plainNotification, probeAgentNotification } from './message'

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
      traceKeepCount: 10,
      traceKeepDays: 30,
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

const twoProbes = (first: boolean, second: boolean): Partial<AlertEvent> => ({
  probeVerdicts: [
    { probe: 'a', name: 'Home', breaching: first, silent: false },
    { probe: 'b', name: 'VPS', breaching: second, silent: false },
  ],
})

describe('a notification for one monitor', () => {
  it('words a firing alert as a failure, with what is wrong in the title', () => {
    expect(notificationFor(event(), { zone: 'UTC' })).toMatchObject({
      title: 'Router: packet loss is too high',
      body:
        '<p><b>Packet loss above 5%</b> for 3 readings in a row.</p>' +
        '<ul>' +
        '<li><b>Address:</b> 192.0.2.1</li>' +
        '<li><b>Now:</b> 42.5%</li>' +
        '<li><b>Group:</b> Home / Network</li>' +
        '<li><b>Alert:</b> Packet loss above 5%</li>' +
        '<li><b>When:</b> 2026-08-19 22:41:43 UTC</li>' +
        '</ul>',
      type: 'failure',
    })
  })

  it('words a recovery as a success', () => {
    const notification = notificationFor(event({ transition: 'resolved', observed: 0 }))
    expect(notification.title).toBe('Router has recovered')
    expect(notification.body).toContain('<p><b>Packet loss above 5%</b> has been clear for 3 readings in a row.</p>')
    expect(notification.type).toBe('success')
  })

  it('gives the likely cause of a monitor that is down, rather than "no reply"', () => {
    const notification = notificationFor(
      event({ metric: 'unreachable', observed: 1, cause: 'it answered with HTTP 503' }, { metric: 'unreachable', threshold: 0, consecutiveProbes: 1 })
    )
    expect(notification.title).toBe('Router is not responding')
    expect(notification.body).toContain('<p><b>Stops responding</b> on the latest reading.</p>')
    expect(notification.body).toContain('<li><b>Likely cause:</b> it answered with HTTP 503</li>')
    expect(notification.body).not.toContain('Now')
  })

  it('lists every probe, the failing ones first, instead of a message from each', () => {
    const notification = notificationFor(event(twoProbes(false, true)))
    expect(notification.title).toBe('Router: packet loss is too high')
    expect(notification.body).toContain('<p><b>Probes:</b> 1 of 2 failing<br>🔴 VPS: failing<br>🟢 Home: fine</p>')
    expect(notification.card?.fields).toContainEqual({ name: 'Probes: 1 of 2 failing', value: '🔴 VPS: failing\n🟢 Home: fine' })
  })

  it('says which probes are not reporting, and what the alert needs when it is not any one', () => {
    const notification = notificationFor(
      event({ probeVerdicts: [{ probe: 'a', name: 'Home', breaching: true, silent: false }, { probe: 'b', name: 'VPS', breaching: false, silent: true }, { probe: 'c', name: 'Office', breaching: true, silent: false }] }, { policy: { kind: 'atLeast', count: 2 } })
    )
    expect(notification.body).toContain('2 of 3 failing, 1 not reporting, the alert needs at least 2 of 3 probes')
    expect(notification.body).toContain('⚪ VPS: not reporting')
  })

  it('says where a monitor measured from one probe agent was measured from', () => {
    expect(notificationFor(event({ probedFrom: 'VPS' })).body).toContain('<li><b>Measured by:</b> VPS</li>')
  })

  it('uses the name of a named alert, and leaves out a group the monitor does not have', () => {
    const notification = notificationFor(event({ targetGroup: undefined }, { name: 'Uplink' }))
    expect(notification.body).toContain('<li><b>Alert:</b> Uplink</li>')
    expect(notification.body).not.toContain('Group')
    expect(notification.card?.fields.map(field => field.name)).not.toContain('Group')
  })

  it('keeps what a monitor or an alert is called from being read as markup', () => {
    const notification = notificationFor(
      event({ targetName: '<b>Core</b> & edge', targetHost: 'a&b.example' }, { name: '*bold* <script>x</script>' })
    )
    // The title is plain text: Apprise escapes it for whichever service it goes to.
    expect(notification.title).toBe('<b>Core</b> & edge: packet loss is too high')
    expect(notification.body).toContain('<li><b>Address:</b> a&amp;b.example</li>')
    expect(notification.body).toContain('<li><b>Alert:</b> *bold* &lt;script&gt;x&lt;/script&gt;</li>')
    expect(notification.card?.fields).toContainEqual({ name: 'Alert', value: '\\*bold\\* <script\\>x</script\\>', inline: true })
  })

  it('lets nothing a monitor is called notify a whole channel', () => {
    // A zero-width space after the @ reads the same and is no longer a mention.
    const notification = notificationFor(event({ targetName: '@everyone' }, { name: 'tell @here' }))
    expect(notification.title).toBe('@​everyone: packet loss is too high')
    expect(JSON.stringify(notification)).not.toMatch(/@(everyone|here)/)
  })

  it('keeps the title within what a service will take', () => {
    expect(notificationFor(event({ targetName: 'x'.repeat(400) })).title.length).toBeLessThanOrEqual(250)
    expect(notificationFor(event({ targetName: 'x'.repeat(400) })).card!.title.length).toBeLessThanOrEqual(256)
  })

  it('marks a test as a test', () => {
    expect(notificationFor(event(), { test: true }).title).toBe('Test: Router: packet loss is too high')
  })

  it('lays the same out as a card, with when it happened for the chat to show in its own time', () => {
    const { card } = notificationFor(event({ cause: 'it did not answer in time' }))
    expect(card).toMatchObject({
      title: 'Router: packet loss is too high',
      description: '**Packet loss above 5%** for 3 readings in a row.\nLikely cause: it did not answer in time',
      at: new Date('2026-08-19T22:41:43.911Z'),
    })
    expect(card?.fields[0]).toEqual({ name: 'Address', value: '`192.0.2.1`', inline: true })
  })
})

describe('a notification for several monitors at once', () => {
  const several = [
    event({ targetName: 'Web', targetHost: 'www.example.net', metric: 'unreachable', cause: 'the connection was refused', ...twoProbes(true, true) }, { metric: 'unreachable', threshold: 0 }),
    event({ targetName: 'Billing', targetHost: 'billing.example.net', targetGroup: undefined, metric: 'unreachable', ...twoProbes(true, false) }, { metric: 'unreachable', threshold: 0 }),
  ]

  it('is one message, saying how many and each one, in order of name', () => {
    const notification = alertNotification(several, { zone: 'UTC' })
    expect(notification.title).toBe('2 monitors are not responding')
    expect(notification.type).toBe('failure')
    expect(notification.body.indexOf('Billing')).toBeLessThan(notification.body.indexOf('Web'))
    expect(notification.body).toContain('<p><b>Web</b><br>www.example.net · Home / Network<br>Likely cause: the connection was refused<br>🔴 Home · 🔴 VPS</p>')
    expect(notification.card?.fields.map(field => field.name)).toEqual(['Billing', 'Web', 'Alert'])
    expect(notification.card?.fields[1].value).toBe('`www.example.net` · Home / Network\nLikely cause: the connection was refused\n🔴 Home · 🔴 VPS')
  })

  it('says they have recovered, together', () => {
    const notification = alertNotification(several.map(each => ({ ...each, transition: 'resolved' as const })))
    expect(notification.title).toBe('2 monitors have recovered')
    expect(notification.type).toBe('success')
  })

  it('counts the monitors past what fits', () => {
    const many = Array.from({ length: 20 }, (_, index) => event({ targetName: `Monitor ${String(index).padStart(2, '0')}` }))
    const notification = alertNotification(many)
    expect(notification.title).toBe('Packet loss is too high on 20 monitors')
    expect(notification.body).toContain('And 5 more monitors.')
    expect(notification.card!.fields.length).toBeLessThanOrEqual(25)
  })
})

describe('probeAgentNotification', () => {
  it('says which probe agent is offline and why, as a failure', () => {
    const note = probeAgentNotification('Home', { kind: 'offline', reason: 'Connection refused' })
    expect(note.title).toBe('Probe agent Home is offline')
    expect(note.type).toBe('failure')
    expect(note.body).toContain('<li><b>Why:</b> Connection refused</li>')
    expect(note.card?.fields).toContainEqual({ name: 'Why', value: 'Connection refused' })
  })

  it('says it is back, as a success, and keeps a name from pinging a channel', () => {
    const note = probeAgentNotification('@everyone', { kind: 'online' })
    expect(note.type).toBe('success')
    expect(note.title).not.toMatch(/@everyone/)
    expect(note.body).not.toContain('Why')
  })
})

describe('plainNotification', () => {
  it('gives a line and the details, in the body and on a card', () => {
    const note = plainNotification('Maintenance finished', 'Ran without problems.', [['Integrity', 'ok']], 'success')
    expect(note.body).toBe('<p>Ran without problems.</p><ul><li><b>Integrity:</b> ok</li></ul>')
    expect(note.card?.fields).toEqual([{ name: 'Integrity', value: 'ok' }])
  })
})
