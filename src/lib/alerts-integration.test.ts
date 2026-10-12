import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProbeResult } from '@/types/probe'
import type { AlertNotification } from './alert-delivery'

interface Delivery {
  urls: string[]
  notification: AlertNotification
}

const NOTIFY_URL = 'jsons://hooks.example.com/clearping'
const { delivered, DOWN_URL } = vi.hoisted(() => ({
  delivered: [] as Delivery[],
  DOWN_URL: 'json://127.0.0.1:1/definitely-not-listening',
}))

// Apprise is stood in for, so that these run where it is not installed and
// send nothing anywhere. The program itself is tried in apprise.test.ts.
vi.mock('./apprise', () => ({
  sendNotification: async (urls: string[], notification: AlertNotification) => {
    if (urls.includes(DOWN_URL)) {
      return { ok: false, detail: 'Apprise could not deliver it: A Connection error occurred' }
    }
    delivered.push({ urls, notification })
    return { ok: true }
  },
}))

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-alerts-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, createTarget, deleteTarget, closeDatabase } = await import('./database')
const {
  createAlert,
  updateAlert,
  deleteAlert,
  getAlert,
  getAlerts,
  getAlertRules,
  evaluateAlerts,
  dispatchAlert,
  deliverAlert,
  sendTestAlert,
  parseAlertInput,
} = await import('./alerts')

const TARGET = { id: 'flaky', name: 'Flaky Link', host: '198.51.100.9', group: 'Home/Uplink' }
const STEADY = { id: 'steady', name: 'Steady Link', host: '198.51.100.10' }

let lossAlertId: string

const probe = (targetId: string, loss: number): ProbeResult => ({
  targetId,
  timestamp: new Date(),
  latency: loss === 100 ? null : 20,
  packetLoss: loss,
  jitter: 2,
  success: loss < 100,
})

/** Feed one probe through the pipeline exactly as the scheduler does. */
async function runProbe(loss: number, target: { id: string; name: string; host: string; group?: string } = TARGET) {
  const events = await evaluateAlerts(target, probe(target.id, loss))
  for (const event of events) await dispatchAlert(event)
  return events
}

const stateOf = async (targetId: string) =>
  (await getAlertRules(targetId)).find(rule => rule.id === lossAlertId)!

beforeAll(async () => {
  await initDatabase()
  for (const target of [TARGET, STEADY]) {
    await createTarget({ ...target, probeType: 'ping', interval: 60, status: 'active' })
  }

  // One alert, ticked for both targets.
  const alert = await createAlert({
    metric: 'packetLoss',
    threshold: 10,
    consecutiveProbes: 3,
    notifyUrls: [NOTIFY_URL],
    targetIds: [TARGET.id, STEADY.id],
  })
  lossAlertId = alert.id
})

afterAll(async () => {
  await closeDatabase()
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
})

describe('alert pipeline', () => {
  it('stays quiet while the breach is shorter than the alert requires', async () => {
    expect(await runProbe(50)).toHaveLength(0)
    expect(await runProbe(50)).toHaveLength(0)
    expect(delivered).toHaveLength(0)

    const rule = await stateOf(TARGET.id)
    expect(rule.state).toBe('ok')
    expect(rule.streak).toBe(2)
  })

  it('fires once the breach is sustained, and sends a notification', async () => {
    const events = await runProbe(50)

    expect(events).toHaveLength(1)
    expect(events[0].transition).toBe('firing')
    expect(events[0].observed).toBe(50)

    expect(delivered).toHaveLength(1)
    expect(delivered[0].urls).toEqual([NOTIFY_URL])
    expect(delivered[0].notification.type).toBe('failure')
    expect(delivered[0].notification.title).toBe('Flaky Link: packet loss is too high')
    expect(delivered[0].notification.body).toContain('<li><b>Now:</b> 50%</li>')
    expect(delivered[0].notification.body).toContain('<li><b>Alert:</b> Packet loss above 10%</li>')
    expect(delivered[0].notification.body).toContain('<li><b>Group:</b> Home / Uplink</li>')

    const rule = await stateOf(TARGET.id)
    expect(rule.state).toBe('firing')
    expect(rule.lastFiredAt).toBeTruthy()
  })

  it('judges each ticked target on its own', async () => {
    // The same alert covers both; one of them being in trouble says nothing
    // about the other.
    await runProbe(0, STEADY)
    expect((await stateOf(STEADY.id)).state).toBe('ok')

    const alert = await getAlert(lossAlertId)
    expect(alert?.targets.map(entry => [entry.targetId, entry.state]).sort()).toEqual([
      ['flaky', 'firing'],
      ['steady', 'ok'],
    ])
  })

  it('does not re-notify while the condition persists', async () => {
    await runProbe(50)
    await runProbe(80)
    expect(delivered).toHaveLength(1)
  })

  it('does not resolve on a single good probe', async () => {
    expect(await runProbe(0)).toHaveLength(0)
    expect((await stateOf(TARGET.id)).state).toBe('firing')
  })

  it('resolves after a sustained recovery and says so', async () => {
    await runProbe(0)
    const events = await runProbe(0)

    expect(events).toHaveLength(1)
    expect(events[0].transition).toBe('resolved')

    expect(delivered).toHaveLength(2)
    expect(delivered[1].notification.type).toBe('success')
    expect(delivered[1].notification.title).toBe('Flaky Link has recovered')

    const rule = await stateOf(TARGET.id)
    expect(rule.state).toBe('ok')
    expect(rule.lastResolvedAt).toBeTruthy()
  })

  it('survives a delivery that fails', async () => {
    // The prober must keep measuring even when the notification endpoint is
    // broken, so a failed delivery is logged rather than thrown.
    const alert = await createAlert({
      metric: 'unreachable',
      threshold: 0,
      consecutiveProbes: 1,
      notifyUrls: [DOWN_URL],
      targetIds: [TARGET.id],
    })

    const events = await evaluateAlerts(TARGET, probe(TARGET.id, 100))
    const unreachableEvent = events.find(e => e.rule.id === alert.id)
    expect(unreachableEvent?.transition).toBe('firing')

    await expect(dispatchAlert(unreachableEvent!)).resolves.toBeUndefined()

    // The same failure, asked for directly, explains itself.
    const result = await deliverAlert(unreachableEvent!)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('Apprise could not deliver it')

    await deleteAlert(alert.id)
  })

  it('does not judge a muted alert', async () => {
    await updateAlert(lossAlertId, { enabled: false })
    for (let i = 0; i < 4; i++) expect(await runProbe(90)).toHaveLength(0)
    expect((await stateOf(TARGET.id)).state).toBe('ok')

    // Switching it back on starts the count from nothing.
    await updateAlert(lossAlertId, { enabled: true })
    expect((await stateOf(TARGET.id)).streak).toBe(0)
  })
})

describe('editing an alert', () => {
  it('keeps the state of targets that stay ticked when another is unticked', async () => {
    for (let i = 0; i < 3; i++) await runProbe(90, STEADY)
    expect((await stateOf(STEADY.id)).state).toBe('firing')

    const updated = await updateAlert(lossAlertId, { targetIds: [STEADY.id] })
    expect(updated?.targets).toHaveLength(1)
    expect(updated?.targets[0]).toMatchObject({ targetId: STEADY.id, state: 'firing' })
    expect(await getAlertRules(TARGET.id)).toEqual([])
  })

  it('ticks a target again with a clean slate, and ignores ids that are not targets', async () => {
    const updated = await updateAlert(lossAlertId, { targetIds: [STEADY.id, TARGET.id, 'no-such-target'] })
    expect(updated?.targets.map(entry => entry.targetId).sort()).toEqual(['flaky', 'steady'])
    expect(await stateOf(TARGET.id)).toMatchObject({ state: 'ok', streak: 0 })
  })

  it('changes what it watches and where it is sent', async () => {
    const several = [NOTIFY_URL, 'discord://123456789012345678/token', 'mailto://user:password@example.com']
    const updated = await updateAlert(lossAlertId, { name: 'Uplink loss', threshold: 25, notifyUrls: several })
    expect(updated).toMatchObject({ name: 'Uplink loss', threshold: 25, notifyUrls: several })

    // An alert that is only shown in the app has nowhere to send to.
    const quiet = await updateAlert(lossAlertId, { notifyUrls: [] })
    expect(quiet?.notifyUrls).toEqual([])
    expect(await sendTestAlert(quiet!, TARGET)).toMatchObject({ ok: false })

    expect(await updateAlert(lossAlertId, { notifyUrls: [NOTIFY_URL] })).toMatchObject({ notifyUrls: [NOTIFY_URL] })
  })

  it('reports an alert that does not exist', async () => {
    expect(await updateAlert('no-such-alert', { enabled: false })).toBeNull()
    expect(await updateAlert('no-such-alert', { targetIds: [] })).toBeNull()
    expect(await deleteAlert('no-such-alert')).toBe(false)
  })

  it('sends a test message that is marked as one and changes nothing', async () => {
    const before = delivered.length
    const alert = (await getAlert(lossAlertId))!
    const stateBefore = await stateOf(TARGET.id)

    expect(await sendTestAlert(alert, TARGET)).toEqual({ ok: true })
    expect(delivered).toHaveLength(before + 1)
    expect(delivered[before].notification.type).toBe('failure')
    expect(delivered[before].notification.title).toMatch(/^Test: Flaky Link/)
    expect(await stateOf(TARGET.id)).toEqual(stateBefore)
  })

  it('unticks a target that is deleted, and goes when the alert is deleted', async () => {
    await deleteTarget(TARGET.id)
    expect((await getAlert(lossAlertId))?.targets.map(entry => entry.targetId)).toEqual([STEADY.id])

    expect(await deleteAlert(lossAlertId)).toBe(true)
    expect(await getAlerts()).toEqual([])
    expect(await getAlertRules(STEADY.id)).toEqual([])
  })
})

describe('parseAlertInput', () => {
  const valid = { metric: 'latency', threshold: 200, consecutiveProbes: 3, targetIds: ['a', 'a', 'b'] }

  it('accepts a whole alert and tidies it', () => {
    const parsed = parseAlertInput({
      ...valid,
      name: '  Slow  ',
      notifyUrls: [' discord://123456789012345678/token ', 'tgram://bot-token/chat-id'],
    })
    expect(parsed).toEqual({
      ok: true,
      input: {
        name: 'Slow',
        metric: 'latency',
        threshold: 200,
        consecutiveProbes: 3,
        notifyUrls: ['discord://123456789012345678/token', 'tgram://bot-token/chat-id'],
        targetIds: ['a', 'b'],
      },
    })
  })

  it('takes the notification URLs as a list or as lines of text, and none as an alert shown only here', () => {
    const urlsFor = (body: Record<string, unknown>) => {
      const parsed = parseAlertInput({ ...valid, ...body })
      return parsed.ok ? parsed.input.notifyUrls : parsed.error
    }
    expect(urlsFor({})).toEqual([])
    expect(urlsFor({ notifyUrls: [] })).toEqual([])
    expect(urlsFor({ notifyUrls: 'ntfy://topic\nmailto://user:password@example.com' })).toEqual([
      'ntfy://topic',
      'mailto://user:password@example.com',
    ])
  })

  it('needs no threshold for an alert on a target being down', () => {
    const parsed = parseAlertInput({ metric: 'unreachable', targetIds: [] })
    expect(parsed).toMatchObject({ ok: true, input: { threshold: 0, consecutiveProbes: 3 } })
  })

  it('says what is wrong with a bad one', () => {
    const errorFor = (body: Record<string, unknown>) => {
      const parsed = parseAlertInput(body)
      return parsed.ok ? null : parsed.error
    }
    expect(errorFor({ ...valid, metric: 'vibes' })).toContain('Invalid metric')
    expect(errorFor({ ...valid, threshold: -1 })).toContain('Threshold')
    expect(errorFor({ ...valid, consecutiveProbes: 0 })).toContain('consecutiveProbes')
    expect(errorFor({ ...valid, notifyUrls: 'my discord channel' })).toContain('notifyUrls')
    expect(errorFor({ ...valid, notifyUrls: ['discord://1/abc', 'hooks.example.com/x'] })).toContain('notifyUrls')
    expect(errorFor({ ...valid, targetIds: 'all' })).toContain('targetIds')
  })

  it('checks only what an edit sends', () => {
    expect(parseAlertInput({ enabled: false }, true)).toEqual({ ok: true, input: { enabled: false } })
    expect(parseAlertInput({ enabled: 'no' }, true)).toMatchObject({ ok: false })
    expect(parseAlertInput({}, true)).toEqual({ ok: true, input: {} })
  })
})
