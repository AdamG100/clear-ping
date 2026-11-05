import { afterEach, describe, expect, it, vi } from 'vitest'

const startScheduler = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/scheduler', () => ({ startScheduler }))

const { POST } = await import('./route')

afterEach(() => {
  vi.unstubAllEnvs()
  startScheduler.mockClear()
})

describe('POST /api/scheduler/start', () => {
  it('starts it', async () => {
    expect((await POST()).status).toBe(200)
    expect(startScheduler).toHaveBeenCalledOnce()
  })

  it('leaves it to the separate process where one does the probing', async () => {
    vi.stubEnv('CLEARPING_EXTERNAL_PROBER', '1')
    expect((await POST()).status).toBe(409)
    expect(startScheduler).not.toHaveBeenCalled()
  })
})
