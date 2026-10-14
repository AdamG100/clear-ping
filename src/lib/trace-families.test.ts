import { describe, expect, it } from 'vitest'
import { canChooseTraceFamily, defaultTraceFamilies, isTraceFamilies, probeRuns } from './host'
import { traceFamiliesProblem } from './traceroute'
import { readingsBoxStyle } from '@/app/_components/monitoring/chart-brush'

describe('choosing the families a route is traced over', () => {
  it('offers a choice for a name, and none for an address', () => {
    expect(canChooseTraceFamily('google.com')).toBe(true)
    expect(canChooseTraceFamily('1.1.1.1')).toBe(false)
    expect(canChooseTraceFamily('2606:4700:4700::1111')).toBe(false)
  })

  it('starts on the families the target is probed over', () => {
    expect(defaultTraceFamilies('google.com', 'both')).toBe('both')
    expect(defaultTraceFamilies('google.com', 'ipv6')).toBe('ipv6')
    expect(defaultTraceFamilies('google.com', 'ipv4')).toBe('ipv4')
    expect(defaultTraceFamilies('google.com', 'auto')).toBe('ipv4')
    expect(defaultTraceFamilies('2606:4700:4700::1111')).toBe('ipv6')
  })

  it('takes only ipv4, ipv6 and both', () => {
    expect(['ipv4', 'ipv6', 'both'].every(isTraceFamilies)).toBe(true)
    expect(isTraceFamilies('auto')).toBe(false)
    expect(isTraceFamilies('v6')).toBe(false)
    expect(isTraceFamilies(undefined)).toBe(false)
  })

  it('runs once per family asked for', () => {
    expect(probeRuns('google.com', 'both').map(run => run.family)).toEqual([4, 6])
    expect(probeRuns('google.com', 'ipv6').map(run => run.family)).toEqual([6])
  })

  it('refuses a family an address does not belong to', () => {
    expect(traceFamiliesProblem('8.8.8.8', 'ipv6')).toMatch(/only be traced over IPv4/)
    expect(traceFamiliesProblem('2001:4860:4860::8888', 'ipv4')).toMatch(/only be traced over IPv6/)
    expect(traceFamiliesProblem('8.8.8.8', 'both')).toBeNull()
    expect(traceFamiliesProblem('google.com', 'ipv6')).toBeNull()
  })
})

describe('where a chart puts the readings under the pointer', () => {
  const chart = { width: 1000, height: 300, top: 10, bottom: 250, halfWidth: 120, boxHeight: 80 }

  it('goes beside the crosshair, on the side with more room', () => {
    expect(readingsBoxStyle(200, [], chart).transform).toBe('translateX(16px)')
    expect(readingsBoxStyle(800, [], chart).transform).toBe('translateX(calc(-100% - 16px))')
  })

  it('goes to the bottom when the points being read are high', () => {
    expect(readingsBoxStyle(500, [20, 40], chart)).toMatchObject({ bottom: 50 })
  })

  it('stays at the top when that covers fewer points', () => {
    expect(readingsBoxStyle(500, [30, 200, 240], chart)).toMatchObject({ top: 10 })
  })

  it('is centred on a phone, where there is no room beside it', () => {
    expect(readingsBoxStyle(10, [], { ...chart, width: 360 }).transform).toBe('translateX(-50%)')
  })
})
