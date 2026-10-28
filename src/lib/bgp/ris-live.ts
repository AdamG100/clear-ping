import type { BgpConnection } from '@/types/bgp'

/**
 * The connection to RIS Live, RIPE NCC's stream of the BGP updates its route
 * collectors receive, as they arrive. One connection carries every prefix
 * watched: each is a subscription on it, to the prefix and anything more
 * specific.
 *
 * It is kept up: asked for a pong now and then, and opened again, a little
 * later each time, whenever it closes or goes quiet for too long.
 */

const URL = 'wss://ris-live.ripe.net/v1/ws/?client=clearping'
const PING_EVERY_MS = 30_000
/** Nothing at all for this long, not even a pong, is a connection that has died without saying. */
const QUIET_LIMIT_MS = 100_000
const RETRY_FIRST_MS = 2_000
const RETRY_MAX_MS = 60_000

/** An UPDATE as RIS Live sends it. */
export interface RisMessage {
  timestamp: number
  peer: string
  peer_asn: string
  host: string
  type: string
  path?: Array<number | number[]>
  announcements?: { next_hop: string; prefixes: string[] }[]
  withdrawals?: string[]
}

interface Handlers {
  onMessage: (message: RisMessage) => void
  /** Each time it opens, the first time and after every break: the moment to catch up. */
  onOpen: () => void
  onChange: (connection: BgpConnection) => void
}

export class RisLive {
  private socket: WebSocket | null = null
  private prefixes = new Set<string>()
  private retryMs = RETRY_FIRST_MS
  private timers: ReturnType<typeof setTimeout>[] = []
  private pinger: ReturnType<typeof setInterval> | null = null
  private lastHeard = 0
  private stopped = true
  connection: BgpConnection = { state: 'off', since: Date.now(), lastMessageAt: null, error: null }

  constructor(private readonly handlers: Handlers) {}

  start(prefixes: Iterable<string>): void {
    this.prefixes = new Set(prefixes)
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.socket?.close()
    this.socket = null
    this.set({ state: 'off', error: null })
  }

  subscribe(prefix: string): void {
    this.prefixes.add(prefix)
    this.send('ris_subscribe', prefix)
  }

  unsubscribe(prefix: string): void {
    this.prefixes.delete(prefix)
    this.send('ris_unsubscribe', prefix)
  }

  private send(type: 'ris_subscribe' | 'ris_unsubscribe', prefix: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ type, data: { prefix, moreSpecific: true, type: 'UPDATE' } }))
  }

  private set(change: Partial<BgpConnection>): void {
    const moved = change.state !== undefined && change.state !== this.connection.state
    this.connection = { ...this.connection, ...change, ...(moved ? { since: Date.now() } : {}) }
    this.handlers.onChange(this.connection)
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    if (this.pinger) clearInterval(this.pinger)
    this.pinger = null
  }

  private open(): void {
    if (this.stopped) return
    this.clearTimers()
    this.set({ state: this.connection.state === 'live' ? 'offline' : 'connecting' })

    let socket: WebSocket
    try {
      socket = new WebSocket(URL)
    } catch (error) {
      this.retry(error instanceof Error ? error.message : String(error))
      return
    }
    this.socket = socket

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      this.retryMs = RETRY_FIRST_MS
      this.lastHeard = Date.now()
      for (const prefix of this.prefixes) this.send('ris_subscribe', prefix)
      this.set({ state: 'live', error: null })
      this.pinger = setInterval(() => {
        if (Date.now() - this.lastHeard > QUIET_LIMIT_MS) {
          // Let go of it first, so its close does not retry a second time.
          this.socket = null
          socket.close()
          this.retry('RIS Live went quiet')
          return
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
      }, PING_EVERY_MS)
      this.handlers.onOpen()
    })

    socket.addEventListener('message', event => {
      if (this.socket !== socket) return
      this.lastHeard = Date.now()
      let message: { type?: string; data?: unknown }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.type === 'ris_message' && message.data) {
        this.connection.lastMessageAt = this.lastHeard
        this.handlers.onMessage(message.data as RisMessage)
      } else if (message.type === 'ris_error') {
        console.warn('[BGP] RIS Live:', JSON.stringify(message.data))
      }
    })

    socket.addEventListener('close', event => {
      if (this.socket !== socket) return
      this.socket = null
      this.retry(event.reason || `Connection closed (${event.code})`)
    })

    socket.addEventListener('error', () => {
      // A close follows, which does the retrying.
    })
  }

  private retry(reason: string): void {
    if (this.stopped) return
    this.clearTimers()
    this.set({ state: 'offline', error: reason })
    const wait = this.retryMs
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2)
    this.timers.push(setTimeout(() => this.open(), wait))
  }
}
