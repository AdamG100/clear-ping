import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlertEvent } from '@/types/probe'

const { sent } = vi.hoisted(() => ({ sent: [] as AlertEvent[][] }))

vi.mock('./store', () => ({
  deliverAlerts: vi.fn(async (events: AlertEvent[]) => {
    sent.push(events)
    return { ok: true }
  }),
  // As the message goes, the second probe has seen it too.
  withProbesNow: vi.fn(async (event: AlertEvent) => ({ ...event, breaching: ['a', 'b'] })),
}))

const { flushAlerts, queueAlert, GROUP_WINDOW_MS } = await import('./outbox')

function event(alertId: string, targetId: string, transition: AlertEvent['transition'] = 'firing'): AlertEvent {
  return {
    rule: { id: alertId, targetId, notifyUrls: ['json://example.net'] } as AlertEvent['rule'],
    targetName: targetId,
    targetHost: `${targetId}.example.net`,
    transition,
    metric: 'unreachable',
    observed: 1,
    threshold: 0,
    at: new Date(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  sent.length = 0
})

afterEach(async () => {
  await flushAlerts()
  vi.useRealTimers()
})

describe('the outbox', () => {
  it('waits, then sends what one alert fired on in that time as one message', async () => {
    queueAlert(event('down', 'web'))
    queueAlert(event('down', 'billing'))
    await vi.advanceTimersByTimeAsync(GROUP_WINDOW_MS - 1)
    expect(sent).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].map(each => each.targetName)).toEqual(['web', 'billing'])
    expect(sent[0][0].breaching).toEqual(['a', 'b'])
  })

  it('keeps a different alert, and an alert clearing, to messages of their own', async () => {
    queueAlert(event('down', 'web'))
    queueAlert(event('slow', 'web'))
    queueAlert(event('down', 'mail', 'resolved'))
    await vi.advanceTimersByTimeAsync(GROUP_WINDOW_MS)
    expect(sent).toHaveLength(3)
  })

  it('holds nothing for an alert that is not sent anywhere', async () => {
    queueAlert({ ...event('quiet', 'web'), rule: { ...event('quiet', 'web').rule, notifyUrls: [] } })
    await flushAlerts()
    expect(sent).toHaveLength(0)
  })
})
