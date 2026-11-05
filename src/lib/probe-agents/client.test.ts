import fs from 'node:fs'
import type { Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameQuery, ProbeResult, ProbeType } from '@/types/probe'
import { createCertificate } from '../../../probe-agent/certificate'
import { createProbeAgentServer, type ProbeAgentWork } from '../../../probe-agent/server'

/**
 * The dashboard's side of probe agents, against real probe agent servers on
 * this machine: pairing, pinning, a certificate that changes, a token that is
 * refused, and an agent that goes away and comes back.
 */

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-agents-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, closeDatabase, createTarget, getDatabase } = await import('../db/database')
const agents = await import('./store')
const { checkProbeAgent, connectProbeAgent, ProbeAgentUnavailableError, runProbes } = await import('./client')
const { listActivity } = await import('../security/settings-store')

const work: ProbeAgentWork = {
  probe: vi.fn(async () => [
    // Its own clock is an hour out; the dashboard's is what counts.
    { targetId: 'not-this', timestamp: new Date(Date.now() - 3_600_000), latency: 25, packetLoss: 0, jitter: 2, success: true } as ProbeResult,
  ]),
  trace: vi.fn(),
}

const servers: Server[] = []

/** A probe agent on a free port, or on `port`, with a certificate of its own unless given one. */
async function startAgent(token: string, port = 0, certificate = createCertificate('test agent')): Promise<{ port: number; certificate: typeof certificate }> {
  const server = createProbeAgentServer({ token, ...certificate, version: '1.0.0', tools: { ping: true, traceroute: true }, work })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, certificate }
}

async function stopAgents(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
}

async function newAgent(name: string, port: number) {
  return agents.createProbeAgent({ name, address: '127.0.0.1', port, exposure: 'private' })
}

beforeAll(async () => {
  await initDatabase()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

beforeEach(async () => {
  await stopAgents()
})

afterAll(async () => {
  await stopAgents()
  await closeDatabase()
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
})

describe('pairing with a probe agent', () => {
  it('pins the certificate it presents, and sends the token only to that', async () => {
    const { probeAgent, token } = await newAgent('Pairing', 1)
    const running = await startAgent(token)
    await agents.updateProbeAgent(probeAgent.id, { port: running.port })

    const outcome = await connectProbeAgent(probeAgent.id)
    expect(outcome).toMatchObject({ ok: true, pinned: true, info: { version: '1.0.0' } })

    const stored = (await agents.getProbeAgent(probeAgent.id))!
    expect(stored.state).toBe('online')
    expect(stored.fingerprint).toBe(outcome?.ok && outcome.fingerprint)
    expect(stored.version).toBe('1.0.0')

    // Connecting again is a test, and pins nothing new.
    expect(await connectProbeAgent(probeAgent.id)).toMatchObject({ ok: true, pinned: false })
  })

  it('forgets a certificate it pinned when that agent refuses the token', async () => {
    const { probeAgent } = await newAgent('Wrong token', 1)
    const running = await startAgent('cpa_' + 'z'.repeat(43))
    await agents.updateProbeAgent(probeAgent.id, { port: running.port })

    expect(await connectProbeAgent(probeAgent.id)).toMatchObject({ ok: false, state: 'token-rejected' })
    const stored = (await agents.getProbeAgent(probeAgent.id))!
    expect(stored.state).toBe('token-rejected')
    expect(stored.fingerprint).toBeUndefined()
  })

  it('refuses a certificate that has changed until it is trusted, and only the one shown', async () => {
    const { probeAgent, token } = await newAgent('Changed', 1)
    const first = await startAgent(token)
    await agents.updateProbeAgent(probeAgent.id, { port: first.port })
    await connectProbeAgent(probeAgent.id)

    // The same place, a new certificate: reinstalled, or someone in between.
    await stopAgents()
    const second = await startAgent(token, first.port)

    const refused = await connectProbeAgent(probeAgent.id)
    expect(refused).toMatchObject({ ok: false, state: 'cert-changed' })
    const offered = refused && !refused.ok ? refused.offeredFingerprint : undefined
    expect(offered).toBeTruthy()
    expect((await agents.getProbeAgent(probeAgent.id))!.offeredFingerprint).toBe(offered)

    // Health checks say the same, and take no reading.
    const connection = (await agents.getProbeAgentConnection(probeAgent.id))!
    expect(await checkProbeAgent(connection)).toBe('cert-changed')

    const trusted = await connectProbeAgent(probeAgent.id, { trustOffered: true })
    expect(trusted).toMatchObject({ ok: true, pinned: true })
    expect((await agents.getProbeAgent(probeAgent.id))!.fingerprint).toBe(offered)
    expect(second.certificate.cert).toBeTruthy()
  })
})

describe('keeping the connection to a probe agent', () => {
  const reading = (probeAgentId: string) =>
    runProbes({ id: 'target-1', host: 'example.com', probeType: 'ping', ipVersion: 'auto', probeConfig: {}, probeAgentId })

  async function paired(name: string) {
    const { probeAgent, token } = await newAgent(name, 1)
    const running = await startAgent(token)
    await agents.updateProbeAgent(probeAgent.id, { port: running.port })
    await connectProbeAgent(probeAgent.id)
    return { id: probeAgent.id, server: servers[servers.length - 1] }
  }

  it('takes reading after reading over one handshake', async () => {
    const { id, server } = await paired('One handshake')
    let handshakes = 0
    server.on('secureConnection', () => handshakes++)

    for (let i = 0; i < 3; i++) expect(await reading(id)).toHaveLength(1)
    expect(handshakes).toBe(0)
  })

  it('makes another, and says nothing of it, when the agent has closed the one it kept', async () => {
    const { id, server } = await paired('Closed')
    const asked = vi.mocked(work.probe).mock.calls.length
    vi.mocked(work.probe).mockImplementationOnce(async () => {
      server.closeAllConnections()
      return []
    })

    expect(await reading(id)).toHaveLength(1)
    expect(vi.mocked(work.probe).mock.calls.length).toBe(asked + 2)
    expect((await agents.getProbeAgent(id))!.state).toBe('online')
  })

  it('holds a kept connection to the certificate that was pinned, not just to its chain', async () => {
    const { id } = await paired('Pinned')
    const stored = (await agents.getProbeAgentConnection(id))!
    // Another record of the same agent, pinned to something it does not present.
    await agents.pinProbeAgentCertificate(id, stored.certPem!, 'AA:BB')
    await expect(reading(id)).rejects.toMatchObject({ state: 'cert-changed' })
  })

  it('still says when the agent has really gone', async () => {
    const { id } = await paired('Gone')
    await stopAgents()
    await expect(reading(id)).rejects.toBeInstanceOf(ProbeAgentUnavailableError)
  })

  it('checks the certificate afresh on a new connection, however many came before', async () => {
    const { probeAgent, token } = await newAgent('Replaced', 1)
    const first = await startAgent(token)
    await agents.updateProbeAgent(probeAgent.id, { port: first.port })
    await connectProbeAgent(probeAgent.id)
    await reading(probeAgent.id)

    await stopAgents()
    await startAgent(token, first.port)
    await expect(reading(probeAgent.id)).rejects.toMatchObject({ state: 'cert-changed' })
  })
})

describe('taking readings through a probe agent', () => {
  it('says to update a probe agent that does not know the kind of monitor, as one from before ARP does not', async () => {
    const { probeAgent, token } = await newAgent('Older', 1)
    const running = await startAgent(token)
    await agents.updateProbeAgent(probeAgent.id, { port: running.port })
    await connectProbeAgent(probeAgent.id)

    // What a probe agent from before ARP makes of an ARP monitor: a probe type it does not know.
    const probeType = 'smtp' as ProbeType
    await expect(runProbes({ id: 'target-arp', host: '192.168.1.20', probeType, ipVersion: 'auto', probeConfig: {}, probeAgentId: probeAgent.id }))
      .rejects.toThrow(/too old for this kind of monitor/)
    // And a game query it does not know, as one from before the UDP echo does not know that.
    const gameQuery = 'hologram' as GameQuery
    await expect(runProbes({ id: 'target-echo', host: '192.0.2.1', probeType: 'game', ipVersion: 'auto', probeConfig: { port: 7770, gameQuery }, probeAgentId: probeAgent.id }))
      .rejects.toThrow(/too old for this kind of monitor/)
  })

  it('stamps them with the dashboard’s clock and the target they are for', async () => {
    const { probeAgent, token } = await newAgent('Readings', 1)
    const running = await startAgent(token)
    await agents.updateProbeAgent(probeAgent.id, { port: running.port })
    await connectProbeAgent(probeAgent.id)

    const before = Date.now()
    const [result] = await runProbes({ id: 'target-1', host: 'example.com', probeType: 'ping', ipVersion: 'auto', probeConfig: {}, probeAgentId: probeAgent.id })
    expect(result.targetId).toBe('target-1')
    expect(result.latency).toBe(25)
    expect(result.timestamp).toBeInstanceOf(Date)
    expect(result.timestamp.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('records an outage when it goes, takes no readings meanwhile, and closes it when it is back', async () => {
    const { probeAgent, token } = await newAgent('Comes and goes', 1)
    const running = await startAgent(token)
    await agents.updateProbeAgent(probeAgent.id, { port: running.port })
    await connectProbeAgent(probeAgent.id)
    await createTarget({ id: 'remote', name: 'Remote', host: 'example.com', probeType: 'ping', interval: 60, status: 'active', probeAgentId: probeAgent.id })

    await stopAgents()
    const gone = (await agents.getProbeAgentConnection(probeAgent.id))!
    // Silent for less than the time it is given: still counted as working, and no outage.
    expect(await checkProbeAgent(gone)).toBe('online')
    expect(await agents.currentOutageStart(probeAgent.id)).toBeNull()
    // Silent for longer than that: offline.
    const database = await getDatabase()
    await new Promise<void>((resolve, reject) =>
      database.run('UPDATE probe_agents SET last_seen_at = ? WHERE id = ?', [Date.now() - 10 * 60_000, probeAgent.id], error => (error ? reject(error) : resolve()))
    )
    expect(await checkProbeAgent((await agents.getProbeAgentConnection(probeAgent.id))!)).toBe('offline')
    expect(await agents.currentOutageStart(probeAgent.id)).not.toBeNull()

    vi.mocked(work.probe).mockClear()
    await expect(
      runProbes({ id: 'remote', host: 'example.com', probeType: 'ping', ipVersion: 'auto', probeConfig: {}, probeAgentId: probeAgent.id })
    ).rejects.toBeInstanceOf(ProbeAgentUnavailableError)
    expect(work.probe).not.toHaveBeenCalled()

    // Asked again while still down: one outage, not two.
    await checkProbeAgent((await agents.getProbeAgentConnection(probeAgent.id))!)
    expect(await agents.probeAgentOutages(probeAgent.id, 0, Date.now() + 1000)).toHaveLength(1)

    await startAgent(token, running.port, running.certificate)
    expect(await checkProbeAgent((await agents.getProbeAgentConnection(probeAgent.id))!)).toBe('online')
    const [outage] = await agents.probeAgentOutages(probeAgent.id, 0, Date.now() + 1000)
    expect(outage.end).not.toBeNull()

    const record = (await listActivity(20)).filter(entry => entry.detail?.startsWith('Comes and goes')).map(entry => entry.action)
    expect(record).toEqual(['probe-agent.online', 'probe-agent.offline'])
  })

  it('probes a target with no probe agent here, as before', async () => {
    await expect(agents.targetsUsingProbeAgent('nobody')).resolves.toEqual([])
    const choice = await agents.readProbeAgentChoice(null)
    expect(choice).toEqual({ ok: true, probeAgentId: null })
    expect(await agents.readProbeAgentChoice('no such agent')).toMatchObject({ ok: false })
  })
})

describe('removing a probe agent', () => {
  it('names the targets still probed from it', async () => {
    const { probeAgent } = await newAgent('In use', 1)
    await createTarget({ id: 'in-use', name: 'Kept target', host: 'example.org', probeType: 'ping', interval: 60, status: 'active', probeAgentId: probeAgent.id })
    expect(await agents.targetsUsingProbeAgent(probeAgent.id)).toEqual(['Kept target'])
    expect((await agents.getProbeAgent(probeAgent.id))!.targetCount).toBe(1)
  })
})
