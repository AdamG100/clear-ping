import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { ProbeResult } from '@/types/probe'

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

interface WebhookPayload {
  status: 'firing' | 'resolved'
  alert: { id: string; name: string }
  target: { name: string; host: string; group: string | null }
  metric: string
  observed: number | null
  threshold: number
  text: string
  test?: boolean
}

const delivered: WebhookPayload[] = []
let server: http.Server
let webhookUrl: string
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
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      delivered.push(JSON.parse(body))
      res.writeHead(200)
      res.end('ok')
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  webhookUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`

  await initDatabase()
  for (const target of [TARGET, STEADY]) {
    await createTarget({ ...target, probeType: 'ping', interval: 60, status: 'active' })
  }

  // One alert, ticked for both targets.
  const alert = await createAlert({
    metric: 'packetLoss',
    threshold: 10,
    consecutiveProbes: 3,
    destination: 'webhook',
    webhookUrl,
    targetIds: [TARGET.id, STEADY.id],
  })
  lossAlertId = alert.id
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
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

  it('fires once the breach is sustained, and delivers a webhook', async () => {
    const events = await runProbe(50)

    expect(events).toHaveLength(1)
    expect(events[0].transition).toBe('firing')
    expect(events[0].observed).toBe(50)

    expect(delivered).toHaveLength(1)
    expect(delivered[0].status).toBe('firing')
    expect(delivered[0].text).toContain('Flaky Link')
    expect(delivered[0].alert).toEqual({ id: lossAlertId, name: 'Packet loss above 10%' })
    expect(delivered[0].target.group).toBe('Home/Uplink')

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
    expect(delivered[1].status).toBe('resolved')
    expect(delivered[1].text).toContain('recovered')

    const rule = await stateOf(TARGET.id)
    expect(rule.state).toBe('ok')
    expect(rule.lastResolvedAt).toBeTruthy()
  })

  it('survives a webhook that refuses the delivery', async () => {
    // The prober must keep measuring even when the notification endpoint is
    // broken, so a failed delivery is logged rather than thrown.
    const alert = await createAlert({
      metric: 'unreachable',
      threshold: 0,
      consecutiveProbes: 1,
      destination: 'webhook',
      webhookUrl: 'http://127.0.0.1:1/definitely-not-listening',
      targetIds: [TARGET.id],
    })

    const events = await evaluateAlerts(TARGET, probe(TARGET.id, 100))
    const unreachableEvent = events.find(e => e.rule.id === alert.id)
    expect(unreachableEvent?.transition).toBe('firing')

    await expect(dispatchAlert(unreachableEvent!)).resolves.toBeUndefined()

    // The same failure, asked for directly, explains itself.
    const result = await deliverAlert(unreachableEvent!)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('Could not reach the webhook')

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

  it('changes what it watches, where it sends and who it mentions', async () => {
    const updated = await updateAlert(lossAlertId, {
      name: 'Uplink loss',
      threshold: 25,
      destination: 'discord',
      mentionRoleIds: ['111111111111111111'],
      mentionUserIds: ['222222222222222222'],
    })
    expect(updated).toMatchObject({
      name: 'Uplink loss',
      threshold: 25,
      destination: 'discord',
      webhookUrl,
      mentionRoleIds: ['111111111111111111'],
      mentionUserIds: ['222222222222222222'],
    })

    // An alert that is only shown in the app has nowhere to send to.
    const quiet = await updateAlert(lossAlertId, { destination: 'none', webhookUrl: '' })
    expect(quiet).toMatchObject({ destination: 'none' })
    expect(quiet?.webhookUrl).toBeUndefined()
    expect(await sendTestAlert(quiet!, TARGET)).toMatchObject({ ok: false })

    expect(await updateAlert(lossAlertId, { destination: 'webhook', webhookUrl })).toMatchObject({
      destination: 'webhook',
      webhookUrl,
    })
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
    expect(delivered[before]).toMatchObject({ status: 'firing', test: true })
    expect(delivered[before].text).toMatch(/^Test: Flaky Link/)
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
      destination: 'discord',
      webhookUrl: ' https://hooks.example.com/x ',
      mentionRoleIds: '111111111111111111, <@&333333333333333333>',
    })
    expect(parsed).toEqual({
      ok: true,
      input: {
        name: 'Slow',
        metric: 'latency',
        threshold: 200,
        consecutiveProbes: 3,
        destination: 'discord',
        webhookUrl: 'https://hooks.example.com/x',
        mentionRoleIds: ['111111111111111111', '333333333333333333'],
        targetIds: ['a', 'b'],
      },
    })
  })

  it('takes the destination from the URL when it is not said', () => {
    const destinationFor = (body: Record<string, unknown>) => {
      const parsed = parseAlertInput({ ...valid, ...body })
      return parsed.ok ? parsed.input.destination : parsed.error
    }
    expect(destinationFor({})).toBe('none')
    expect(destinationFor({ webhookUrl: 'https://hooks.example.com/x' })).toBe('webhook')
    expect(destinationFor({ webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/abc' })).toBe('discord')
  })

  it('drops what a destination has no use for', () => {
    const quiet = parseAlertInput({ ...valid, destination: 'none', webhookUrl: 'https://hooks.example.com/x' })
    expect(quiet).toMatchObject({ ok: true, input: { destination: 'none', webhookUrl: '' } })

    const plain = parseAlertInput({
      ...valid,
      destination: 'webhook',
      webhookUrl: 'https://hooks.example.com/x',
      mentionRoleIds: ['111111111111111111'],
    })
    expect(plain).toMatchObject({ ok: true, input: { mentionRoleIds: [], mentionUserIds: [] } })
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
    expect(errorFor({ ...valid, webhookUrl: 'ftp://example.com' })).toContain('Webhook URL')
    expect(errorFor({ ...valid, destination: 'pigeon' })).toContain('Invalid destination')
    expect(errorFor({ ...valid, destination: 'discord' })).toContain('webhook URL')
    expect(errorFor({ ...valid, destination: 'webhook', webhookUrl: '' })).toContain('webhook URL')
    expect(errorFor({ ...valid, mentionUserIds: '@everyone' })).toContain('User IDs')
    expect(errorFor({ ...valid, targetIds: 'all' })).toContain('targetIds')
  })

  it('checks only what an edit sends', () => {
    expect(parseAlertInput({ enabled: false }, true)).toEqual({ ok: true, input: { enabled: false } })
    expect(parseAlertInput({ enabled: 'no' }, true)).toMatchObject({ ok: false })
    expect(parseAlertInput({}, true)).toEqual({ ok: true, input: {} })
  })
})
