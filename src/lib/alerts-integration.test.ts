import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { ProbeResult } from '@/types/probe'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-alerts-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, createTarget, closeDatabase } = await import('./database')
const {
  ensureAlertSchema,
  createAlertRule,
  evaluateAlerts,
  dispatchAlert,
  getAlertRules,
} = await import('./alerts')

const TARGET = { id: 'flaky', name: 'Flaky Link', host: '198.51.100.9' }

interface WebhookPayload {
  status: 'firing' | 'resolved'
  metric: string
  observed: number | null
  threshold: number
  text: string
}

const delivered: WebhookPayload[] = []
let server: http.Server
let webhookUrl: string

const probe = (loss: number): ProbeResult => ({
  targetId: TARGET.id,
  timestamp: new Date(),
  latency: loss === 100 ? null : 20,
  packetLoss: loss,
  jitter: 2,
  success: loss < 100,
})

/** Feed one probe through the pipeline exactly as the scheduler does. */
async function runProbe(loss: number) {
  const events = await evaluateAlerts(TARGET, probe(loss))
  for (const event of events) await dispatchAlert(event)
  return events
}

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
  await ensureAlertSchema()
  await createTarget({
    ...TARGET,
    probeType: 'ping',
    interval: 60,
    status: 'active',
  })
  await createAlertRule({
    targetId: TARGET.id,
    metric: 'packetLoss',
    threshold: 10,
    consecutiveProbes: 3,
    webhookUrl,
  })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await closeDatabase()
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
})

describe('alert pipeline', () => {
  it('stays quiet while the breach is shorter than the rule requires', async () => {
    expect(await runProbe(50)).toHaveLength(0)
    expect(await runProbe(50)).toHaveLength(0)
    expect(delivered).toHaveLength(0)

    const [rule] = await getAlertRules(TARGET.id)
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

    const [rule] = await getAlertRules(TARGET.id)
    expect(rule.state).toBe('firing')
    expect(rule.lastFiredAt).toBeTruthy()
  })

  it('does not re-notify while the condition persists', async () => {
    await runProbe(50)
    await runProbe(80)
    expect(delivered).toHaveLength(1)
  })

  it('does not resolve on a single good probe', async () => {
    expect(await runProbe(0)).toHaveLength(0)
    const [rule] = await getAlertRules(TARGET.id)
    expect(rule.state).toBe('firing')
  })

  it('resolves after a sustained recovery and says so', async () => {
    await runProbe(0)
    const events = await runProbe(0)

    expect(events).toHaveLength(1)
    expect(events[0].transition).toBe('resolved')

    expect(delivered).toHaveLength(2)
    expect(delivered[1].status).toBe('resolved')
    expect(delivered[1].text).toContain('recovered')

    const [rule] = await getAlertRules(TARGET.id)
    expect(rule.state).toBe('ok')
    expect(rule.lastResolvedAt).toBeTruthy()
  })

  it('survives a webhook that refuses the delivery', async () => {
    // The prober must keep measuring even when the notification endpoint is
    // broken, so a failed delivery is logged rather than thrown.
    const rule = await createAlertRule({
      targetId: TARGET.id,
      metric: 'unreachable',
      threshold: 0,
      consecutiveProbes: 1,
      webhookUrl: 'http://127.0.0.1:1/definitely-not-listening',
    })

    const events = await evaluateAlerts(TARGET, probe(100))
    const unreachableEvent = events.find(e => e.rule.id === rule.id)
    expect(unreachableEvent?.transition).toBe('firing')

    await expect(dispatchAlert(unreachableEvent!)).resolves.toBeUndefined()
  })
})
