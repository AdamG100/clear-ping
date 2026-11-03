import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbeResult } from '@/types/probe'
import { createCertificate } from './certificate'
import { createProbeAgentServer, type ProbeAgentWork } from './server'

const TOKEN = 'cpa_' + 'a'.repeat(43)
const { cert, key } = createCertificate('test agent')

const work: ProbeAgentWork = {
  probe: vi.fn(async target => [
    { targetId: target.id, timestamp: new Date('2026-10-20T12:00:00Z'), latency: 12, packetLoss: 0, jitter: 1, success: true } as ProbeResult,
  ]),
  trace: vi.fn(async (target, ipVersion) => ({
    id: 'trace',
    targetId: target.id,
    timestamp: new Date(),
    trigger: 'manual' as const,
    address: ipVersion === 'ipv6' ? '::1' : '127.0.0.1',
    hops: [],
    reached: true,
  })),
}

const logged: string[] = []
const server = createProbeAgentServer({ token: TOKEN, key, cert, version: '9.9.9', tools: { ping: true, traceroute: true }, work, log: line => logged.push(line) })
let port = 0

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

function ask(
  method: string,
  path: string,
  options: { token?: string | null; body?: string } = {}
): Promise<{ status: number; body: unknown }> {
  const token = options.token === undefined ? TOKEN : options.token
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        ca: cert,
        checkServerIdentity: () => undefined,
        agent: false,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown = text
          try {
            body = JSON.parse(text)
          } catch {
            // Plain text, as /healthz answers.
          }
          resolve({ status: response.statusCode ?? 0, body })
        })
      }
    )
    request.on('error', reject)
    request.end(options.body)
  })
}

describe('the probe agent’s server', () => {
  it('can be reached over TLS with its own certificate pinned', async () => {
    const { status, body } = await ask('GET', '/v1/info')
    expect(status).toBe(200)
    expect(body).toMatchObject({ version: '9.9.9', protocol: 1, tools: { ping: true, traceroute: true } })
  })

  it('answers nothing without the token', async () => {
    expect((await ask('GET', '/v1/info', { token: null })).status).toBe(401)
    expect((await ask('GET', '/v1/info', { token: 'cpa_wrong' })).status).toBe(401)
    const probe = await ask('POST', '/v1/probe', { token: null, body: '{"target":{"id":"t","host":"1.1.1.1","probeType":"ping"}}' })
    expect(probe.status).toBe(401)
    expect(work.probe).not.toHaveBeenCalled()
  })

  it('runs a probe it is given, and sends back the readings', async () => {
    const { status, body } = await ask('POST', '/v1/probe', {
      body: JSON.stringify({ target: { id: 't1', host: ' example.com ', probeType: 'tcp', probeConfig: { port: 443 } } }),
    })
    expect(status).toBe(200)
    expect((body as { results: ProbeResult[] }).results[0]).toMatchObject({ targetId: 't1', latency: 12, success: true })
    expect(work.probe).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', host: 'example.com', probeType: 'tcp', ipVersion: 'auto', probeConfig: expect.objectContaining({ port: 443 }) })
    )
  })

  it('refuses a probe no target could be', async () => {
    expect((await ask('POST', '/v1/probe', { body: '{"target":{"id":"t","host":"not a host","probeType":"ping"}}' })).status).toBe(400)
    expect((await ask('POST', '/v1/probe', { body: '{"target":{"id":"t","host":"1.1.1.1","probeType":"smtp"}}' })).status).toBe(400)
    // A TCP probe needs a port.
    expect((await ask('POST', '/v1/probe', { body: '{"target":{"id":"t","host":"1.1.1.1","probeType":"tcp"}}' })).status).toBe(400)
    expect((await ask('POST', '/v1/probe', { body: 'not json' })).status).toBe(400)
  })

  it('refuses a body far larger than any probe', async () => {
    const huge = JSON.stringify({ target: { id: 't', host: '1.1.1.1', probeType: 'ping', padding: 'x'.repeat(70 * 1024) } })
    const outcome = await ask('POST', '/v1/probe', { body: huge }).catch(() => ({ status: 413, body: null }))
    expect(outcome.status).toBe(413)
  })

  it('traces a route over the family asked for', async () => {
    const { status, body } = await ask('POST', '/v1/traceroute', { body: '{"target":{"id":"t","host":"localhost"},"ipVersion":"ipv6"}' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ targetId: 't', address: '::1' })
  })

  it('knows only its own routes', async () => {
    expect((await ask('GET', '/v1/probe')).status).toBe(404)
    expect((await ask('GET', '/admin')).status).toBe(404)
  })

  it('answers the health check to this machine without a token', async () => {
    expect(await ask('GET', '/healthz', { token: null })).toEqual({ status: 200, body: 'ok' })
  })

  describe('what it logs of a reading', () => {
    const asked = JSON.stringify({ target: { id: 't', host: '192.0.2.1', probeType: 'ping' } })
    const reading = (fields: Partial<ProbeResult>) => [{ targetId: 't', timestamp: new Date(), latency: 12, packetLoss: 0, jitter: 1, success: true, ...fields } as ProbeResult]

    beforeEach(() => {
      logged.length = 0
    })
    afterEach(() => vi.unstubAllEnvs())

    it('nothing, when it came back clean', async () => {
      await ask('POST', '/v1/probe', { body: asked })
      expect(logged).toEqual([])
    })

    it.each([
      ['failed', { success: false, packetLoss: 100, latency: null }],
      ['lost something', { packetLoss: 5 }],
    ])('a line, when it %s', async (_label, fields) => {
      vi.mocked(work.probe).mockResolvedValueOnce(reading(fields))
      await ask('POST', '/v1/probe', { body: asked })
      expect(logged).toHaveLength(1)
    })

    it('every one, when asked to', async () => {
      vi.stubEnv('CLEARPING_LOG_READINGS', '1')
      await ask('POST', '/v1/probe', { body: asked })
      expect(logged).toHaveLength(1)
    })
  })

  it('makes an address that keeps guessing wait', async () => {
    const statuses: number[] = []
    for (let attempt = 0; attempt < 12; attempt++) statuses.push((await ask('GET', '/v1/info', { token: 'cpa_guess' })).status)
    expect(statuses.slice(0, 10).every(status => status === 401)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
    // Even the right token waits its turn.
    expect((await ask('GET', '/v1/info')).status).toBe(429)
  })
})
