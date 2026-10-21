import { describe, expect, it, vi } from 'vitest'
import { ConnectionLost, reconnecting, type Link } from './transport'

const REPLY = Buffer.from('reply')
const QUESTION = Buffer.from('question')

/** A link that answers the given way for each question it is asked, in turn. */
function fakeLink(answers: Array<'reply' | 'lost' | 'timeout'>): Link & { closed: boolean } {
  let closed = false
  const link = {
    get closed() { return closed },
    usable: () => !closed,
    exchange: vi.fn(async () => {
      const answer = answers.shift() ?? 'reply'
      if (answer === 'lost') {
        closed = true
        throw new ConnectionLost('Resolver closed the connection')
      }
      if (answer === 'timeout') throw new Error('No answer within 5000ms')
      return REPLY
    }),
    close: () => { closed = true },
  }
  return link
}

describe('reconnecting', () => {
  it('asks again on a new connection when the resolver closes the one in use', async () => {
    const first = fakeLink(['lost'])
    const second = fakeLink([])
    const open = vi.fn().mockResolvedValue(second)
    const connection = reconnecting(first, open)

    await expect(connection.exchange(QUESTION)).resolves.toBe(REPLY)
    expect(open).toHaveBeenCalledTimes(1)
    expect(second.exchange).toHaveBeenCalledWith(QUESTION)
  })

  it('opens a new connection for the next question once the old one has gone', async () => {
    const first = fakeLink([])
    const second = fakeLink([])
    const connection = reconnecting(first, vi.fn().mockResolvedValue(second))

    await connection.exchange(QUESTION)
    first.close()
    await expect(connection.exchange(QUESTION)).resolves.toBe(REPLY)
    expect(second.exchange).toHaveBeenCalledTimes(1)
  })

  it('counts a question as failed when no answer comes, without reconnecting', async () => {
    const open = vi.fn()
    const connection = reconnecting(fakeLink(['timeout']), open)

    await expect(connection.exchange(QUESTION)).rejects.toThrow('No answer within 5000ms')
    expect(open).not.toHaveBeenCalled()
  })

  it('retries only once: losing the new connection too is a failed question', async () => {
    const connection = reconnecting(fakeLink(['lost']), vi.fn().mockResolvedValue(fakeLink(['lost'])))

    await expect(connection.exchange(QUESTION)).rejects.toBeInstanceOf(ConnectionLost)
  })

  it('fails the rest at once when the resolver cannot be reached again', async () => {
    const open = vi.fn().mockRejectedValue(new Error('No connection to dns.example within 5000ms'))
    const connection = reconnecting(fakeLink(['lost']), open)

    await expect(connection.exchange(QUESTION)).rejects.toThrow('No connection to dns.example')
    await expect(connection.exchange(QUESTION)).rejects.toThrow('No connection to dns.example')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('closes whichever connection is current', async () => {
    const first = fakeLink(['lost'])
    const second = fakeLink([])
    const connection = reconnecting(first, vi.fn().mockResolvedValue(second))

    await connection.exchange(QUESTION)
    connection.close()
    expect(second.closed).toBe(true)
  })
})
