import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logReading } from './log'

describe('logReading', () => {
  let printed: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    printed = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('says nothing of a clean reading', () => {
    logReading({ success: true, packetLoss: 0 }, 'clean')
    expect(printed).not.toHaveBeenCalled()
  })

  it.each([
    ['failed', { success: false, packetLoss: 100 }],
    ['lost something', { success: true, packetLoss: 5 }],
  ])('always says when a reading %s', (_label, result) => {
    logReading(result, 'trouble')
    expect(printed).toHaveBeenCalledWith('trouble')
  })

  it('says every reading when asked to', () => {
    vi.stubEnv('CLEARPING_LOG_READINGS', '1')
    logReading({ success: true, packetLoss: 0 }, 'clean')
    expect(printed).toHaveBeenCalledWith('clean')
  })
})
