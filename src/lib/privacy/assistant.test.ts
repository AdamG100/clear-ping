import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/database', () => ({
  getAllTargets: vi.fn(async () => [{ host: 'office.example.com', resolvedAddress: '198.51.100.20' }]),
}))
vi.mock('../probe-agents/store', () => ({
  listProbeAgents: vi.fn(async () => [{ address: '203.0.113.5', hostname: 'vps-berlin' }]),
}))

const { withAddressesHidden } = await import('./assistant')

const answerWith = (text: string) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })

describe('what an assistant is given, with addresses hidden', () => {
  it('hides the addresses in a tool’s JSON answer and leaves the rest', async () => {
    const [answer] = await withAddressesHidden([
      answerWith(JSON.stringify({ targets: [{ name: 'Office', host: 'office.example.com', latencyMs: 12 }], from: 'vps-berlin' })),
    ])
    expect(JSON.parse(answer.result.content[0].text)).toEqual({
      targets: [{ name: 'Office', host: 'o•••.•••.com', latencyMs: 12 }],
      from: 'v•••',
    })
  })

  it('hides known names and IP addresses in a plain answer', async () => {
    const [answer] = await withAddressesHidden([answerWith('There is no target at office.example.com (198.51.100.20).')])
    expect(answer.result.content[0].text).toBe('There is no target at o•••.•••.com (•••.•••.•••.20).')
  })

  it('leaves an answer without content as it is', async () => {
    const error = { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'No such method' } }
    expect(await withAddressesHidden([error])).toEqual([error])
  })
})
