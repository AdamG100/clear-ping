import { describe, expect, it } from 'vitest'
import { describeGroupHealth, groupIsOnline, groupIsPaused, summarizeGroupHealth } from './group-health'

const online = (packetLoss = 0) => ({ status: 'active' as const, isOnline: true, packetLoss })
const offline = { status: 'active' as const, isOnline: false, packetLoss: 100 }
const pending = { status: 'active' as const, isOnline: undefined }
const paused = { status: 'paused' as const, isOnline: true, packetLoss: 40 }

describe('summarizeGroupHealth', () => {
  it('counts each target once, by what it is doing now', () => {
    expect(summarizeGroupHealth([online(), online(3), offline, pending, paused])).toEqual({
      online: 2,
      offline: 1,
      pending: 1,
      paused: 1,
      worstLoss: 3,
    })
  })

  it('takes the worst loss from the targets that are answering, and no others', () => {
    // The paused target lost 40% before it was paused; the offline one is
    // counted as down, not as a loss figure.
    expect(summarizeGroupHealth([online(1.5), online(12), offline, paused]).worstLoss).toBe(12)
  })
})

describe('the group as one light', () => {
  it('is down if anything in it is down', () => {
    expect(groupIsOnline(summarizeGroupHealth([online(), online(), offline]))).toBe(false)
  })

  it('is up when something answers and nothing is down', () => {
    expect(groupIsOnline(summarizeGroupHealth([online(), pending, paused]))).toBe(true)
  })

  it('is undecided when nothing has been measured', () => {
    expect(groupIsOnline(summarizeGroupHealth([pending, paused]))).toBeUndefined()
    expect(groupIsOnline(summarizeGroupHealth([]))).toBeUndefined()
  })

  it('is paused only when everything in it is', () => {
    expect(groupIsPaused(summarizeGroupHealth([paused, paused]))).toBe(true)
    expect(groupIsPaused(summarizeGroupHealth([paused, online()]))).toBe(false)
    expect(groupIsPaused(summarizeGroupHealth([]))).toBe(false)
  })
})

describe('describeGroupHealth', () => {
  it('lists the counts that are not zero, bad news first', () => {
    expect(describeGroupHealth(summarizeGroupHealth([online(), online(), offline]))).toBe('1 offline, 2 online')
    expect(describeGroupHealth(summarizeGroupHealth([online()]))).toBe('1 online')
    expect(describeGroupHealth(summarizeGroupHealth([pending, paused]))).toBe('1 pending, 1 paused')
  })

  it('says so when there is nothing to count', () => {
    expect(describeGroupHealth(summarizeGroupHealth([]))).toBe('no targets')
  })
})
