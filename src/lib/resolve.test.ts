import { describe, expect, it, vi } from 'vitest'
import { resolveHost } from './resolve'

const V6 = { address: '2001:db8::1', family: 6 }
const V4 = { address: '192.0.2.1', family: 4 }

function errno(code: string) {
  return Object.assign(new Error(code), { code })
}

describe('resolveHost', () => {
  it('takes the first address the system lists when left on auto', async () => {
    const lookupFn = vi.fn().mockResolvedValue([V6, V4])

    await expect(resolveHost('example.com', 'auto', { lookupFn })).resolves.toEqual({
      ok: true,
      ...V6,
      addresses: [V6.address, V4.address],
    })
    expect(lookupFn).toHaveBeenCalledWith('example.com', { all: true, family: 0, order: 'verbatim' })
  })

  it('stays on one server of a round-robin name whatever order the records come back in', async () => {
    const records = ['20.70.246.20', '20.112.250.133', '20.76.201.171'].map(address => ({ address, family: 4 }))
    const rotations = records.map((_, shift) => [...records.slice(shift), ...records.slice(0, shift)])

    const chosen = await Promise.all(
      rotations.map(async order => {
        const outcome = await resolveHost('rr.example', 'ipv4', { lookupFn: vi.fn().mockResolvedValue(order) })
        return outcome.ok ? outcome.address : outcome.error
      })
    )
    expect(new Set(chosen).size).toBe(1)
  })

  it('keeps the family the system prefers when choosing among several addresses', async () => {
    const V6b = { address: '2001:db8::0', family: 6 }
    const outcome = await resolveHost('example.com', 'auto', { lookupFn: vi.fn().mockResolvedValue([V6, V4, V6b]) })
    expect(outcome).toMatchObject({ ok: true, family: 6, address: V6b.address })
  })

  it.each([
    ['ipv4', 4, V4],
    ['ipv6', 6, V6],
  ] as const)('asks the resolver for %s only', async (ipVersion, family, answer) => {
    const lookupFn = vi.fn().mockResolvedValue([answer])

    await expect(resolveHost('example.com', ipVersion, { lookupFn })).resolves.toEqual({
      ok: true,
      ...answer,
      addresses: [answer.address],
    })
    expect(lookupFn.mock.calls[0][1].family).toBe(family)
  })

  it('names the missing record when a name has no address of the requested family', async () => {
    const lookupFn = vi.fn().mockRejectedValue(errno('ENOTFOUND'))

    const outcome = await resolveHost('v4only.example', 'ipv6', { lookupFn })
    expect(outcome).toEqual({
      ok: false,
      error: 'DNS resolution failed: no IPv6 address (AAAA record) for v4only.example',
    })
  })

  it('reports a name that does not resolve at all, with the resolver code', async () => {
    const lookupFn = vi.fn().mockRejectedValue(errno('ENOTFOUND'))

    const outcome = await resolveHost('nope.invalid', 'auto', { lookupFn })
    expect(outcome).toEqual({ ok: false, error: 'DNS resolution failed for nope.invalid (ENOTFOUND)' })
  })

  it('treats an empty answer as a failure rather than probing nothing', async () => {
    const outcome = await resolveHost('empty.example', 'auto', { lookupFn: vi.fn().mockResolvedValue([]) })
    expect(outcome.ok).toBe(false)
  })

  it('gives up on a resolver that never answers', async () => {
    const lookupFn = vi.fn().mockReturnValue(new Promise(() => {}))

    const outcome = await resolveHost('slow.example', 'auto', { lookupFn, timeoutMs: 20 })
    expect(outcome).toEqual({ ok: false, error: 'DNS resolution failed for slow.example (timed out)' })
  })
})
