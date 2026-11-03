import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fixture from '../__fixtures__/ping-output'

/**
 * How a ping reading is taken, with \`ping\` stood in for. The real program is
 * tried in the Docker image's smoke test, against 127.0.0.1.
 */

type Answer = { stdout?: string; stderr?: string; fail?: boolean }

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile, default: { execFile } }))

const realPlatform = process.platform
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

/** `ping` answering each call in turn, the last answer from then on. */
function pingAnswers(...answers: Answer[]): void {
  let call = 0
  execFile.mockImplementation((_command: string, _args: string[], _options: unknown, done: (error: unknown, out?: unknown) => void) => {
    const answer = answers[Math.min(call++, answers.length - 1)]
    if (answer.fail) done(Object.assign(new Error('Command failed'), answer))
    else done(null, { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' })
  })
}

async function ping(count = 20) {
  // Afresh each time: what it has learned of this machine's `ping` is the module's.
  vi.resetModules()
  const { executePing } = await import('./ping')
  return executePing('target', '192.0.2.1', { count })
}

beforeEach(() => {
  execFile.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  onPlatform(realPlatform)
  vi.restoreAllMocks()
})

describe('a ping reading on Linux', () => {
  beforeEach(() => onPlatform('linux'))

  it('starts one program for the whole round', async () => {
    pingAnswers({ stdout: fixture.LINUX_ROUND })
    const result = await ping(4)

    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile.mock.calls[0][1]).toEqual(['-n', '-c', '4', '-i', '0.05', '-W', '1', '-4', '192.0.2.1'])
    expect(result).toMatchObject({ success: true, packetLoss: 0, latency: 12.5, minLatency: 10, maxLatency: 15 })
  })

  it('counts what did not come back as loss, from a non-zero exit too', async () => {
    pingAnswers({ stdout: fixture.LINUX_ROUND_WITH_LOSS, fail: true })
    expect(await ping(4)).toMatchObject({ success: true, packetLoss: 50, latency: 11 })
  })

  it('reports nothing coming back in the same words as before', async () => {
    pingAnswers({ stdout: fixture.LINUX_ROUND_ALL_LOST, fail: true })
    const result = await ping(4)
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: false, packetLoss: 100, latency: null })
    expect(result.errorMessage).toMatch(/100% packet loss/)
  })

  it('reports having nowhere to send it, without giving up on rounds', async () => {
    pingAnswers({ stderr: 'ping: connect: Network is unreachable', fail: true })
    const result = await ping(4)
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: false, packetLoss: 100, errorMessage: 'ping: connect: Network is unreachable' })
  })

  it('sends each packet on its own where this ping will not send that fast, and does not ask again', async () => {
    const refused = { stderr: 'ping: cannot flood; minimal interval allowed for user is 200ms', fail: true }
    pingAnswers(refused, { stdout: fixture.LINUX_REPLY })
    vi.resetModules()
    const { executePing } = await import('./ping')

    expect(await executePing('target', '192.0.2.1', { count: 3, interval: 0 })).toMatchObject({ success: true, packetLoss: 0, latency: 12.3 })
    expect(execFile).toHaveBeenCalledTimes(4)
    expect(execFile.mock.calls[1][1]).toContain('1')

    await executePing('target', '192.0.2.1', { count: 3, interval: 0 })
    expect(execFile).toHaveBeenCalledTimes(7)
  })
})

describe('a ping reading elsewhere', () => {
  it.each(['win32', 'darwin'] as const)('sends each packet on its own on %s', async platform => {
    onPlatform(platform)
    pingAnswers({ stdout: platform === 'win32' ? fixture.WINDOWS_REPLY : fixture.MACOS_REPLY })
    vi.resetModules()
    const { executePing } = await import('./ping')
    const result = await executePing('target', '192.0.2.1', { count: 3, interval: 0 })
    expect(execFile).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ success: true, packetLoss: 0 })
  })
})
