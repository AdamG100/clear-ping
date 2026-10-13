import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ProbeMeasurement } from '@/types/probe'

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-mcp-')), 'test.db')
process.env.CLEARPING_DB_PATH = dbFile

const { initDatabase, closeDatabase, createTarget, getAllTargets, storeMeasurements } = await import('./database')
const { ensureTracerouteSchema, storeTraceroute } = await import('./traceroute')
const { handleMessage } = await import('./mcp-protocol')
const { clearPingMcp } = await import('./mcp-tools')

/**
 * Three hours of a small network, a probe a minute, ending now:
 *
 *   Router    192.168.1.1   answers throughout
 *   Internet  1.1.1.1       no reply from 60 to 45 minutes ago
 *   Website   example.com   fails from 58 to 47 minutes ago
 *
 * The router answering while both things beyond it fail is the whole of what
 * a report to an ISP rests on.
 */
const MINUTE = 60_000
const now = Math.floor(Date.now() / MINUTE) * MINUTE
const ago = (minutes: number) => new Date(now - minutes * MINUTE)

function history(targetId: string, down: (minutesAgo: number) => boolean, reason: string): ProbeMeasurement[] {
  return Array.from({ length: 180 }, (_, index) => {
    const minutesAgo = 180 - index
    const failed = down(minutesAgo)
    return {
      id: `${targetId}-${index}`,
      targetId,
      timestamp: ago(minutesAgo),
      latency: failed ? null : 12,
      packetLoss: failed ? 100 : 0,
      jitter: failed ? null : 1,
      success: !failed,
      errorMessage: failed ? reason : undefined,
    }
  })
}

/** Call a tool the way a client does, and read back what it returned. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const answered = await handleMessage(clearPingMcp, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  const result = answered?.result as { content: Array<{ text: string }>; isError?: boolean }
  return { isError: result.isError === true, text: result.content[0].text }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- what a tool returns is read as a client reads it, as JSON
const data = async (name: string, args: Record<string, unknown> = {}): Promise<any> => JSON.parse((await call(name, { timezone: 'UTC', ...args })).text)

beforeAll(async () => {
  await initDatabase()
  await ensureTracerouteSchema()

  await createTarget({ id: 'router', name: 'Router', host: '192.168.1.1', probeType: 'ping', interval: 60, status: 'active', group: 'Home/Network' })
  await createTarget({ id: 'internet', name: 'Internet', host: '1.1.1.1', probeType: 'ping', interval: 60, status: 'active', group: 'Outside' })
  await createTarget({
    id: 'website',
    name: 'Website',
    host: 'example.com',
    probeType: 'http',
    interval: 60,
    status: 'active',
    group: 'Outside',
    probeConfig: { scheme: 'https', path: '/' },
  })

  await storeMeasurements([
    ...history('router', () => false, ''),
    ...history('internet', minutes => minutes <= 60 && minutes > 45, 'Request timed out'),
    ...history('website', minutes => minutes <= 58 && minutes > 47, 'connect ETIMEDOUT'),
  ])

  await storeTraceroute({
    id: 'trace-1',
    targetId: 'internet',
    timestamp: ago(59),
    trigger: 'alert',
    address: '1.1.1.1',
    reached: false,
    hops: [
      { hop: 1, address: '192.168.1.1', hostname: null, rtts: [1.1, 1.3, 1.2], sent: 3 },
      { hop: 2, address: null, rtts: [], sent: 3 },
      { hop: 3, address: null, rtts: [], sent: 3 },
    ],
  })
})

afterAll(async () => {
  await closeDatabase()
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
})

describe('what is offered', () => {
  it('is a set of tools that only read, and a prompt for the report', async () => {
    const listed = (await handleMessage(clearPingMcp, { jsonrpc: '2.0', id: 1, method: 'tools/list' }))?.result as {
      tools: Array<{ name: string; annotations: { readOnlyHint: boolean }; inputSchema: { type: string } }>
    }

    expect(listed.tools.map(tool => tool.name)).toEqual([
      'list_targets',
      'build_isp_report',
      'get_incidents',
      'get_target_history',
      'get_traceroutes',
      'get_dns_resolvers',
    ])
    expect(listed.tools.every(tool => tool.annotations.readOnlyHint && tool.inputSchema.type === 'object')).toBe(true)

    const prompt = (await handleMessage(clearPingMcp, { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'isp_report', arguments: { days: '14', isp: 'Acme Fibre' } } }))
      ?.result as { messages: Array<{ content: { text: string } }> }
    expect(prompt.messages[0].content.text).toContain('last 14 days')
    expect(prompt.messages[0].content.text).toContain('Acme Fibre')
    expect(prompt.messages[0].content.text).toContain('build_isp_report with days=14')
  })
})

describe('list_targets', () => {
  it('says what is monitored, where it sits, and how its latest probe went', async () => {
    const { targets } = await data('list_targets')
    const named = (name: string) => targets.find((target: { name: string }) => target.name === name)

    expect(targets.map((target: { name: string }) => target.name).sort()).toEqual(['Internet', 'Router', 'Website'])
    expect(named('Router')).toMatchObject({
      id: 'router',
      address: '192.168.1.1',
      probe: 'ICMP ping',
      group: 'Home / Network',
      probedEverySeconds: 60,
      paused: false,
      insideLocalNetwork: true,
      latest: { answering: true, lossPercent: 0, latencyMs: 12 },
    })
    expect(named('Internet').insideLocalNetwork).toBe(false)
    expect(named('Website')).toMatchObject({ address: 'https://example.com/', probe: 'HTTP(S) request' })
  })
})

describe('build_isp_report', () => {
  it('finds the outages, and says what kept working through them', async () => {
    const report = await data('build_isp_report')

    expect(report.totals).toMatchObject({ targetsMonitored: 3, targetsWithIncidents: 2, outages: 2, spellsOfLoss: 0 })
    expect(report.totals.longestOutage).toMatchObject({ target: 'Internet', duration: '15m' })

    expect(report.outages).toHaveLength(2)
    expect(report.spellsOfLoss).toEqual({ total: 0, worst: [] })
    const [internet, website] = report.outages
    expect(internet).toMatchObject({
      target: 'Internet',
      kind: 'outage',
      start: new Date(now - 60 * MINUTE).toISOString().replace('.000Z', '+00:00'),
      end: new Date(now - 45 * MINUTE).toISOString().replace('.000Z', '+00:00'),
      duration: '15m',
      failedProbes: 15,
      reasons: ['Request timed out'],
      meanwhile: { alsoAffected: ['Website'], unaffected: ['Router'] },
    })
    expect(website).toMatchObject({ target: 'Website', duration: '11m', reasons: ['connect ETIMEDOUT'], meanwhile: { alsoAffected: ['Internet'], unaffected: ['Router'] } })
  })

  it('sums each target up over the period', async () => {
    const { results } = await data('build_isp_report')
    const of = (name: string) => results.find((row: { target: string }) => row.target === name)

    expect(of('Router')).toMatchObject({ probes: 180, uptimePercent: 100, lossPercent: 0, outages: 0, timeInOutage: '0s', longestOutage: null })
    expect(of('Internet')).toMatchObject({ probes: 180, failedProbes: 15, outages: 1, timeInOutage: '15m', longestOutage: '15m' })
    expect(of('Internet').uptimePercent).toBeCloseTo(91.667, 2)
    expect(of('Internet').latencyMs).toMatchObject({ median: 12, max: 12 })
  })

  it('brings the route traced through the failure, and where its replies stopped', async () => {
    const { traceroutes } = await data('build_isp_report')

    expect(traceroutes).toHaveLength(1)
    expect(traceroutes[0]).toMatchObject({
      target: 'Internet',
      trigger: 'automatic, when an alert fired',
      reachedTheTarget: false,
      repliesStopAtHop: 2,
    })
    expect(traceroutes[0].hops[0]).toBe('1  192.168.1.1  1.2 ms  loss 0%')
  })

  it('says what the data can and cannot show', async () => {
    const whole = await data('build_isp_report')
    expect(whole.caveats.join(' ')).toContain('Inside the local network: Router')
    expect(whole.byHourOfDay.targets.map((each: { target: string }) => each.target)).toEqual(['Internet', 'Website'])
    // An hour to a line, and between them every probe that got no reply.
    const noReply = whole.byHourOfDay.targets[0].hours.reduce((sum: number, line: string) => sum + Number(/no reply (\d+)/.exec(line)?.[1]), 0)
    expect(noReply).toBe(15)
    expect(whole.byHourOfDay.targets[0].hours[0]).toMatch(/^\d\d:00 {2}probes \d+ {2}no reply \d+ {2}loss [\d.]+% {2}median 12 ms$/)
    expect(whole.monitorNotRunning).toEqual([])

    // Without the router in it, there is nothing to tell inside from outside by.
    const outside = await data('build_isp_report', { group: 'Outside' })
    expect(outside.totals.targetsMonitored).toBe(2)
    expect(outside.caveats.join(' ')).toContain('No target inside the local network')
    expect(outside.outages[0].meanwhile.unaffected).toEqual([])
  })

  it('keeps to the period it is given', async () => {
    const lastHalfHour = await data('build_isp_report', { hours: 0.5 })
    expect(lastHalfHour.totals).toMatchObject({ outages: 0, targetsWithIncidents: 0 })
    expect(lastHalfHour.outages).toEqual([])
    // The route was traced before it began.
    expect(lastHalfHour.traceroutes).toEqual([])
    expect(lastHalfHour.caveats.join(' ')).toContain('No traceroute was saved')
  })
})

describe('the other tools', () => {
  it('get_incidents can be narrowed to some targets, a kind and a length', async () => {
    expect((await data('get_incidents', { targets: ['website'] })).incidents.map((each: { target: string }) => each.target)).toEqual(['Website'])
    expect((await data('get_incidents', { min_minutes: 12 })).incidents.map((each: { target: string }) => each.target)).toEqual(['Internet'])
    expect((await data('get_incidents', { kind: 'loss' })).incidents).toEqual([])
    expect((await data('get_incidents', { limit: 1 })).incidentsNotListed).toBe(1)
  })

  it('get_target_history gives one target in depth, found by part of its name', async () => {
    const history = await data('get_target_history', { target: 'inter', hours: 3 })

    expect(history.target).toMatchObject({ id: 'internet', name: 'Internet' })
    expect(history.series).toHaveLength(1)
    expect(history.series[0]).toMatchObject({ outages: 1, timeInOutage: '15m', monitoringGaps: [] })
    expect(history.series[0].incidents[0]).toMatchObject({ kind: 'outage', duration: '15m' })
    expect(history.series[0].byHourOfDay.every((line: unknown) => typeof line === 'string')).toBe(true)
  })

  it('get_traceroutes lists the saved routes of a target', async () => {
    expect((await data('get_traceroutes', { target: 'Internet' })).traceroutes).toHaveLength(1)
    expect((await data('get_traceroutes', { target: 'Router' })).traceroutes).toEqual([])
  })
})

describe('a request that cannot be answered', () => {
  it('says what is wrong in words that can be acted on', async () => {
    const unknown = await call('get_target_history', { target: 'Routr2' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toBe('There is no target called "Routr2". There is: Internet, Router, Website.')

    expect((await call('get_target_history', {})).text).toContain('Say which target')
    expect((await call('get_incidents', { hours: -3 })).text).toBe('hours must be a number greater than zero.')
    expect((await call('get_incidents', { start: 'last tuesday' })).text).toContain('start is not a date-time')
    expect((await call('get_incidents', { days: 900 })).text).toBe('A period can be at most 366 days.')
    expect((await call('list_targets', { timezone: 'Mars/Olympus' })).text).toContain('not a time zone')
    expect((await call('build_isp_report', { group: 'Nowhere' })).text).toBe('No target is in a group called "Nowhere".')
    expect((await call('get_dns_resolvers', { target: 'Router' })).text).toContain('not a DNS target with a list of resolvers')
  })
})

// Last, since it adds to what the tests above count.
describe('changing things, for a connection that sent the token', () => {
  /** Call a tool as a connection that is allowed to write. */
  async function write(name: string, args: Record<string, unknown> = {}) {
    const answered = await handleMessage(
      clearPingMcp,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      { writes: true }
    )
    const result = answered?.result as { content: Array<{ text: string }>; isError?: boolean }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- read as a client reads it, as JSON
    return { isError: result.isError === true, text: result.content[0].text, data: (result.isError ? null : JSON.parse(result.content[0].text)) as any }
  }
  const named = async (name: string) => (await getAllTargets()).find(target => target.name === name)

  // Something to probe that is on this machine and answers.
  let listening: net.Server
  let port: number
  beforeAll(async () => {
    listening = net.createServer(socket => socket.end())
    await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', resolve))
    port = (listening.address() as net.AddressInfo).port
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    await new Promise(resolve => listening.close(resolve))
  })

  it('offers the tools that change something only to such a connection, and none that deletes', async () => {
    const offered = async (writes: boolean) =>
      ((await handleMessage(clearPingMcp, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { writes }))?.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)

    const reading = await offered(false)
    const writing = await offered(true)

    expect(reading).toHaveLength(6)
    expect(writing.filter(name => !reading.includes(name))).toEqual(['add_targets', 'update_target', 'set_target_paused', 'probe_now', 'run_traceroute'])
    expect(writing.some(name => /delete|remove|alert/.test(name))).toBe(false)
  })

  it('refuses to change anything for a connection that did not', async () => {
    const refused = await call('add_targets', { targets: [{ address: '192.0.2.50' }] })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('this connection may only read')
    expect(await named('192.0.2.50')).toBeUndefined()
  })

  it('adds targets from as little as an address, working out the probe as the form does', async () => {
    const { data } = await write('add_targets', {
      targets: [
        { address: '192.168.1.254', name: 'Switch', group: 'Home/Network' },
        { address: 'https://status.example.org/health', interval_seconds: 60 },
        { address: `127.0.0.1:${port}`, name: 'Local service' },
        { address: 'example.net', probe: 'dns', ip_version: 'both', settings: { resolvers: [{ protocol: 'udp', server: '1.1.1.1' }, { protocol: 'doh', server: 'dns.google', name: 'G' }] } },
      ],
    })

    expect(data.added.map((target: { name: string }) => target.name)).toEqual(['Switch', 'status.example.org', 'Local service', 'example.net'])
    expect(data.added[0]).toMatchObject({ address: '192.168.1.254', probe: 'ICMP ping', group: 'Home / Network', probedEverySeconds: 300, insideLocalNetwork: true })

    expect(await named('status.example.org')).toMatchObject({ probeType: 'http', host: 'status.example.org', interval: 60, probeConfig: { scheme: 'https', path: '/health' } })
    expect(await named('Local service')).toMatchObject({ probeType: 'tcp', host: '127.0.0.1', probeConfig: { port } })
    expect(await named('example.net')).toMatchObject({
      probeType: 'dns',
      ipVersion: 'both',
      probeConfig: { resolvers: [{ protocol: 'udp', server: '1.1.1.1' }, { protocol: 'doh', server: 'https://dns.google/dns-query', name: 'G' }] },
    })
  })

  it('does not add what is already monitored the same way, and says so', async () => {
    const { data } = await write('add_targets', { targets: [{ address: '192.168.1.1', name: 'Router again' }, { address: '192.0.2.77' }] })

    expect(data.alreadyMonitored).toEqual([{ address: '192.168.1.1', as: 'Router' }])
    expect(data.added.map((target: { name: string }) => target.name)).toEqual(['192.0.2.77'])
    expect(await named('Router again')).toBeUndefined()

    const again = await write('add_targets', { targets: [{ address: '192.0.2.77' }] })
    expect(again.data.added).toEqual([])
    expect(again.data.note).toContain('Nothing was added')
  })

  it('adds none of a list with a mistake in it, and says which', async () => {
    const before = (await getAllTargets()).length
    const refused = await write('add_targets', { targets: [{ address: '192.0.2.88' }, { address: 'db.internal', probe: 'tcp' }] })

    expect(refused.isError).toBe(true)
    expect(refused.text).toBe('Target 2 (db.internal): A TCP target needs a port between 1 and 65535.')
    expect(await getAllTargets()).toHaveLength(before)

    expect((await write('add_targets', { targets: [] })).text).toContain('as a list')
    expect((await write('add_targets', { targets: [{ name: 'No address' }] })).text).toBe('Target 1: give its address.')
    expect((await write('add_targets', { targets: Array.from({ length: 51 }, (_, index) => ({ address: `198.51.100.${index}` })) })).text).toContain('At most 50')
  })

  it('changes only what it is asked to of a target', async () => {
    const { data } = await write('update_target', { target: 'Switch', name: 'Core switch', interval_seconds: 120, group: '' })

    expect(data.changed.sort()).toEqual(['group', 'interval', 'name'])
    expect(await named('Core switch')).toMatchObject({ host: '192.168.1.254', probeType: 'ping', interval: 120 })
    expect((await named('Core switch'))?.group ?? '').toBe('')

    // Settings given are added to the ones it has.
    await write('update_target', { target: 'status.example.org', settings: { expectedStatus: 204 } })
    expect((await named('status.example.org'))?.probeConfig).toEqual({ scheme: 'https', path: '/health', expectedStatus: 204 })

    expect((await write('update_target', { target: 'Core switch', interval_seconds: 120 })).text).toContain('Nothing to change')
    expect((await write('update_target', { target: 'Core switch', interval_seconds: 3 })).text).toContain('Interval must be between')
    expect((await named('Core switch'))?.interval).toBe(120)
  })

  it('pauses a target and starts it again, keeping what it has recorded', async () => {
    expect((await write('set_target_paused', { target: 'Internet', paused: true })).data).toMatchObject({ target: 'Internet', paused: true })
    expect((await named('Internet'))?.status).toBe('paused')
    expect((await write('set_target_paused', { target: 'Internet', paused: true })).data.note).toContain('already')

    expect((await write('set_target_paused', { target: 'Internet', paused: false })).data.paused).toBe(false)
    expect((await named('Internet'))?.status).toBe('active')
    expect((await data('get_target_history', { target: 'Internet', hours: 3 })).series[0].outages).toBe(1)

    expect((await write('set_target_paused', { target: 'Internet' })).text).toContain('paused must be true or false')
  })

  it('takes a reading now, and keeps it', async () => {
    const { data: reading } = await write('probe_now', { target: 'Local service', timezone: 'UTC' })

    expect(reading).toMatchObject({ target: 'Local service', answering: true, lossPercent: 0 })
    expect(reading.latencyMs).toBeGreaterThanOrEqual(0)
    expect((await data('get_target_history', { target: 'Local service', hours: 1 })).series[0].probes).toBe(1)
  })
})
