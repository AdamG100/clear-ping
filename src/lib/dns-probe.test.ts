import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DnsResolver } from '@/types/probe'
import { executeDnsProbe } from './dns'
import { addressRecord, askedName, askedType, wireRecord, wireReply } from './__fixtures__/dns-messages'

/**
 * A DNS probe asking several resolvers, against resolvers that are a local
 * HTTP server: nothing here leaves the machine. Each path of the server is a
 * resolver with a temperament of its own.
 */

let server: http.Server
let port: number
/** Connections opened to the server, to see that one is kept and reused. */
let connections = 0
let questions = 0

const resolver = (path: string): DnsResolver => ({ protocol: 'doh', server: `http://127.0.0.1:${port}${path}` })
const label = (path: string) => `127.0.0.1:${port}${path === '/dns-query' ? '' : path} DoH`

const ANSWERS: Record<string, string[]> = {
  '/dns-query': ['192.0.2.1', '192.0.2.2'],
  '/other': ['192.0.2.2', '192.0.2.1'],
  '/stale': ['198.51.100.7'],
}
/** 2001:db8::1 */
const IPV6_ANSWER = Buffer.from('20010db8000000000000000000000001', 'hex')

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      questions++
      const path = request.url ?? ''
      const name = askedName(Buffer.concat(chunks))

      if (path === '/silent') return // Never answers.
      if (path === '/broken') {
        response.writeHead(500).end('no')
        return
      }

      const known = name === 'example.com' ? ANSWERS[path] : undefined
      // The one resolver that also has the name's IPv6 address.
      const reply = known && path === '/dns-query' && askedType(Buffer.concat(chunks)) === 'AAAA'
        ? wireReply(name, 'AAAA', [wireRecord('AAAA', IPV6_ANSWER)])
        : path === '/servfail'
        ? wireReply(name, 'A', [], { rcode: 2 })
        : known
          ? wireReply(name, 'A', known.map(addressRecord))
          : wireReply(name, 'A', [], { rcode: 3 })

      response.writeHead(200, { 'content-type': 'application/dns-message', 'content-length': reply.length }).end(reply)
    })
  })
  server.on('connection', () => connections++)

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterAll(async () => {
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
})

beforeEach(() => {
  connections = 0
  questions = 0
})

const probe = (name: string, paths: string[], options: Parameters<typeof executeDnsProbe>[2] = {}) =>
  executeDnsProbe('target', name, { resolvers: paths.map(resolver), count: 3, interval: 0, timeout: 1500, ...options })

describe('a name asked of several resolvers', () => {
  it('reports all of their queries as one reading, and each resolver beside it', async () => {
    const result = await probe('example.com', ['/dns-query', '/other'])

    expect(result).toMatchObject({ success: true, packetLoss: 0, resolvedAddress: '192.0.2.1' })
    expect(result.errorMessage).toBeUndefined()
    expect(result.latency).toBeGreaterThan(0)
    expect(result.details?.answers).toEqual(['192.0.2.1', '192.0.2.2'])

    expect(result.details?.resolvers).toMatchObject([
      { label: label('/dns-query'), protocol: 'doh', loss: 0, answers: ['192.0.2.1', '192.0.2.2'] },
      { label: label('/other'), protocol: 'doh', loss: 0, answers: ['192.0.2.2', '192.0.2.1'] },
    ])
    for (const reading of result.details?.resolvers ?? []) {
      expect(reading.latency).toBeGreaterThan(0)
      expect(reading.connectMs).toBeGreaterThanOrEqual(0)
      expect(reading.error).toBeUndefined()
    }
  })

  it('opens one connection to each resolver and asks every question down it', async () => {
    await probe('example.com', ['/dns-query'])
    expect(questions).toBe(3)
    expect(connections).toBe(1)
  })

  it('counts a resolver that fails as its share of the queries lost, and says which', async () => {
    const result = await probe('example.com', ['/dns-query', '/broken', '/servfail'])

    expect(result.success).toBe(true)
    expect(result.packetLoss).toBeCloseTo(66.67, 1)
    expect(result.errorMessage).toBeUndefined()
    expect(result.details?.resolvers).toMatchObject([
      { loss: 0 },
      { label: label('/broken'), latency: null, loss: 100, error: 'Resolver answered HTTP 500' },
      { label: label('/servfail'), latency: null, loss: 100, error: 'Resolver answered SERVFAIL' },
    ])
  })

  it('fails a resolver whose answer is not the expected one, and keeps what it said', async () => {
    const result = await probe('example.com', ['/dns-query', '/stale'], { expectedAnswer: '192.0.2.2' })

    expect(result.packetLoss).toBe(50)
    expect(result.details?.resolvers).toMatchObject([
      { loss: 0 },
      { loss: 100, answers: ['198.51.100.7'], error: 'Unexpected answer: got 198.51.100.7, expected 192.0.2.2' },
    ])
  })

  it('fails altogether when the name is nowhere, naming every resolver that said so', async () => {
    const result = await probe('gone.example', ['/dns-query', '/other'])

    expect(result).toMatchObject({ success: false, packetLoss: 100, latency: null })
    expect(result.errorMessage).toBe(
      `${label('/dns-query')}: No A record for gone.example; ${label('/other')}: No A record for gone.example`
    )
    expect(result.resolvedAddress).toBeUndefined()
  })

  it('gives up on a resolver that does not answer in time, without holding up the others', async () => {
    const result = await probe('example.com', ['/silent', '/dns-query'], { count: 2, timeout: 200 })

    expect(result.packetLoss).toBe(50)
    expect(result.details?.resolvers).toMatchObject([
      { loss: 100, latency: null, error: 'No answer within 200ms' },
      { loss: 0 },
    ])
  })

  it('reports a resolver that cannot be reached at all', async () => {
    // Port 9 on this machine: nothing is listening.
    const dead: DnsResolver = { protocol: 'doh', server: 'http://127.0.0.1:9/dns-query' }
    const result = await executeDnsProbe('target', 'example.com', {
      resolvers: [dead, resolver('/dns-query')],
      count: 2,
      interval: 0,
      timeout: 1500,
    })

    expect(result.success).toBe(true)
    expect(result.packetLoss).toBe(50)
    expect(result.details?.resolvers?.[0]).toMatchObject({ label: '127.0.0.1:9 DoH', loss: 100, latency: null })
    expect(result.details?.resolvers?.[0].error).toBeTruthy()
    expect(result.details?.resolvers?.[0].connectMs).toBeUndefined()
  })

  it('asks for the address of the IP version the target is on, whatever record was saved with it', async () => {
    // A target set to both is probed once over each, and the IPv6 one used to
    // ask for the A record again and report an IPv4 address as its answer.
    const overIpv6 = await probe('example.com', ['/dns-query'], { recordType: 'A', ipVersion: 'ipv6' })
    expect(overIpv6).toMatchObject({ success: true, resolvedAddress: '2001:db8::1' })
    expect(overIpv6.details?.resolvers?.[0].answers).toEqual(['2001:db8::1'])

    const overIpv4 = await probe('example.com', ['/dns-query'], { recordType: 'AAAA', ipVersion: 'ipv4' })
    expect(overIpv4.resolvedAddress).toBe('192.0.2.1')

    // Left to itself, the version leaves the record as it was asked for.
    const unpinned = await probe('example.com', ['/dns-query'], { recordType: 'AAAA' })
    expect(unpinned.resolvedAddress).toBe('2001:db8::1')
  })

  it('calls a resolver by the name it was given, with how it is asked', async () => {
    const result = await executeDnsProbe('target', 'example.com', {
      resolvers: [{ ...resolver('/dns-query'), name: 'Office' }],
      count: 1,
      interval: 0,
      timeout: 1500,
    })
    // And says where it is and how much it was asked, which is what a later
    // rename is followed by and what "answered" is out of.
    expect(result.details?.resolvers?.[0]).toMatchObject({
      label: 'Office DoH',
      server: `http://127.0.0.1:${port}/dns-query`,
      sent: 1,
      loss: 0,
    })
  })

  it('will not ask the system resolver for anything but an address', async () => {
    const result = await executeDnsProbe('target', 'example.com', {
      resolvers: [{ protocol: 'system' }, resolver('/dns-query')],
      recordType: 'MX',
      count: 1,
      interval: 0,
      timeout: 1500,
    })

    expect(result.details?.resolvers?.[0]).toMatchObject({
      label: 'System resolver',
      loss: 100,
      error: 'The system resolver only looks up addresses, not MX records',
    })
  })
})
