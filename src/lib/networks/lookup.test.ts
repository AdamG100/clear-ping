import { beforeEach, describe, expect, it, vi } from 'vitest'

const addressAsn = vi.fn(async (): Promise<number | null> => 64500)
const asName = vi.fn(async (): Promise<string | null> => 'Example Networks')
const exchangeData = vi.fn(async () => null as unknown)

vi.mock('../bgp/ripestat', () => ({ addressAsn, asName }))
vi.mock('../bgp/exchanges', () => ({
  exchangeData,
  exchangeOf: (_address: string, lans: Array<{ prefix: string; exchange: { name: string } }>) => lans[0] ?? null,
  memberOf: (_address: string, ports: Record<string, number>) => Object.values(ports)[0] ?? null,
}))
vi.mock('../bgp/store', () => ({ knownAsNames: vi.fn(async () => new Map()), saveNetwork: vi.fn(async () => {}) }))

const { networkOf } = await import('./lookup')

beforeEach(() => {
  addressAsn.mockClear()
  asName.mockClear()
})

describe('who runs an address', () => {
  it('never looks up an address that is not on the internet', async () => {
    for (const address of ['192.0.2.1', '10.0.0.7', '2001:db8::1']) {
      expect(await networkOf(address)).toEqual({ address, private: true })
    }
    expect(addressAsn).not.toHaveBeenCalled()
  })

  it('gives the network that holds a public address, and remembers it', async () => {
    expect(await networkOf('1.1.1.1')).toEqual({ address: '1.1.1.1', asn: 64500, name: 'Example Networks' })
    await networkOf('1.1.1.1')
    expect(addressAsn).toHaveBeenCalledTimes(1)
  })

  it('names the member and the exchange for an address on a peering LAN, which no route announces', async () => {
    exchangeData.mockResolvedValueOnce({ lans: [{ prefix: '1.0.0.0/24', exchange: { name: 'Example IX' } }], ports: { 'x': 64501 } })
    expect(await networkOf('1.0.0.9')).toMatchObject({ asn: 64501, exchange: 'Example IX' })
    expect(addressAsn).not.toHaveBeenCalled()
  })

  it('says nothing, and tries again next time, when it cannot find out', async () => {
    addressAsn.mockRejectedValueOnce(new Error('unreachable'))
    expect(await networkOf('1.0.0.77')).toBeNull()
    expect(await networkOf('1.0.0.77')).toMatchObject({ asn: 64500 })
  })
})
