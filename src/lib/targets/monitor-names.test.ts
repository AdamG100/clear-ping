import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { eitherNames, monitorRoute, withBothKeys, withMonitorKeys, withTargetKeys } from './monitor-names'

describe('withMonitorKeys', () => {
  it('names every target key for monitors, however deep', () => {
    expect(withMonitorKeys({ targets: [{ targetId: 'a', name: 'Router', reachedTheTarget: true }], latest: { a: { targetId: 'a' } } })).toEqual({
      monitors: [{ monitorId: 'a', name: 'Router', reachedTheMonitor: true }],
      latest: { a: { monitorId: 'a' } },
    })
  })

  it('leaves map keys that are ids alone, even ones that say target', () => {
    expect(withMonitorKeys({ 'target-1': 1, 'b1946ac9-target': 2 })).toEqual({ 'target-1': 1, 'b1946ac9-target': 2 })
  })
})

describe('withBothKeys', () => {
  it('keeps each target key and puts a monitor-named copy beside it', () => {
    expect(withBothKeys({ targets: [{ targetId: 'a', state: 'ok' }] })).toEqual({
      targets: [{ targetId: 'a', monitorId: 'a', state: 'ok' }],
      monitors: [{ monitorId: 'a', state: 'ok' }],
    })
  })
})

describe('withTargetKeys', () => {
  it('takes monitor names for the target names the code reads, and never touches other words', () => {
    expect(withTargetKeys({ monitorIds: ['a'], monitor: 'Router', monitoring: true })).toEqual({ targetIds: ['a'], target: 'Router', monitoring: true })
  })

  it('lets the old name win when both are sent', () => {
    expect(withTargetKeys({ monitorIds: ['a'], targetIds: ['b'] })).toEqual({ targetIds: ['b'] })
  })
})

describe('the route wrappers', () => {
  const echo = async (request: NextRequest) =>
    Response.json({ asked: request.nextUrl.searchParams.get('targets'), body: request.body ? await request.json() : null, targetId: 'a' }, { status: 201 })

  it('monitorRoute takes and gives monitor names, keeping the status', async () => {
    const response = await monitorRoute(echo)(
      new NextRequest('http://localhost/api/monitors?monitors=a,b', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"monitorIds":["a"]}' }),
      {}
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ asked: 'a,b', body: { monitorIds: ['a'] }, monitorId: 'a' })
  })

  it('eitherNames answers with both names', async () => {
    const response = await eitherNames(echo)(new NextRequest('http://localhost/api/compare?targets=a'), {})
    expect(await response.json()).toEqual({ asked: 'a', body: null, targetId: 'a', monitorId: 'a' })
  })
})
