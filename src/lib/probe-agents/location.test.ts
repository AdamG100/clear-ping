import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * A probe's country and network, found from its public address: a probe
 * agent's own when it is public, or else the first hop on the internet in the
 * probe's newest trace. Nothing is looked up while the privacy switch is off.
 */

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-location-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

// Documentation ranges stand in for public addresses here; the LAN ones stay private.
vi.mock('../bgp/prefix', () => ({ isPublicAddress: (address: string) => !/^(10|192\.168)\./.test(address) }))
vi.mock('../bgp/ripestat', () => ({
  addressCountry: async (address: string) => (address === '198.51.100.1' ? 'NL' : address === '203.0.113.9' ? 'ZA' : null),
  asCountry: async () => null,
}))
vi.mock('../networks/lookup', () => ({
  networkOf: async (address: string) => ({ address, asn: address === '198.51.100.1' ? 64500 : 64501, name: address === '198.51.100.1' ? 'Example Transit' : 'Example Access' }),
}))
const privacy = { lookUpNetworks: true }
vi.mock('../privacy/settings', () => ({ getPrivacySettings: async () => privacy }))
const agents: { id: string; address: string }[] = []
vi.mock('./store', () => ({ listProbeAgents: async () => agents }))

const { initDatabase, closeDatabase } = await import('../db/database')
const { ensureTracerouteSchema, storeTraceroute } = await import('../traceroute/store')
const { foundPlaces, forgetFoundPlace } = await import('./location')

beforeAll(async () => {
  await initDatabase()
  await ensureTracerouteSchema()
})
afterAll(async () => {
  await closeDatabase()
})

const hop = (n: number, address: string | null) => ({ hop: n, address, rtts: [1], sent: 3 })

describe('where a probe is', () => {
  it('is found from the first hop on the internet in its newest trace, or a probe agent’s own public address', async () => {
    // Traces need a monitor to belong to.
    const { createTarget } = await import('../db/database')
    await createTarget({ id: 'example', name: 'Example', host: '192.0.2.10', probeType: 'ping', interval: 60, status: 'active', group: '' })
    await storeTraceroute({
      id: 'trace-1', targetId: 'example', timestamp: new Date(), trigger: 'manual', address: '192.0.2.10', reached: true, probe: 'local',
      hops: [hop(1, '192.168.1.1'), hop(2, null), hop(3, '203.0.113.9'), hop(4, '198.51.100.1')],
    })
    agents.push({ id: 'agent-1', address: '198.51.100.1' }, { id: 'agent-2', address: '10.0.0.5' })

    const found = await foundPlaces({ wait: true })
    expect(found.get('local')).toMatchObject({ address: '203.0.113.9', from: 'trace', country: 'ZA', countryName: 'South Africa', asn: 64501, network: 'Example Access' })
    expect(found.get('agent-1')).toMatchObject({ address: '198.51.100.1', from: 'address', country: 'NL', network: 'Example Transit' })
    // A private address and no trace: not found.
    expect(found.has('agent-2')).toBe(false)
  })

  it('looks nothing up while addresses may not be looked up', async () => {
    privacy.lookUpNetworks = false
    forgetFoundPlace('local')
    expect((await foundPlaces({ wait: true })).size).toBe(0)
    privacy.lookUpNetworks = true
  })
})
