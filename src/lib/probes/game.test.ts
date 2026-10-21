import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import dgram from 'node:dgram'
import net, { type AddressInfo } from 'node:net'
import { executeGameProbe } from './game'
import { readVarInt, takePacket, varInt } from './game/minecraft'

/**
 * The UDP probe against local servers that answer as game servers do: nothing
 * here leaves the machine. Each server speaks one of the query formats, the
 * way the real thing does, challenge and all.
 */

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff])
const A2S_INFO = Buffer.concat([OOB, Buffer.from('TSource Engine Query\0', 'latin1')])
const CHALLENGE = Buffer.from([0x0a, 0x0b, 0x0c, 0x0d])
const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex')

/** An A2S_INFO reply, as a Rust server would send it. */
function a2sInfoReply(): Buffer {
  const text = (value: string) => Buffer.from(`${value}\0`, 'utf8')
  return Buffer.concat([
    OOB,
    Buffer.from([0x49, 17]),
    text('Big Rust Server | EU'),
    text('Procedural Map'),
    text('rust'),
    text('Rust'),
    Buffer.from([0x00, 0x00]), // app id: anything but The Ship's
    Buffer.from([42, 100, 0, 0x64, 0x6c, 0, 1]), // players, max, bots, dedicated, Linux, public, VAC
    text('2589'),
  ])
}

function raknetPong(ping: Buffer): Buffer {
  const motd = Buffer.from('MCPE;Bedrock Realm;712;1.21.40;3;20;123456789;Survival World;Survival;1;19132;19133;', 'utf8')
  const length = Buffer.alloc(2)
  length.writeUInt16BE(motd.length)
  return Buffer.concat([Buffer.from([0x1c]), ping.subarray(1, 9), Buffer.alloc(8, 7), RAKNET_MAGIC, length, motd])
}

const servers: dgram.Socket[] = []
let minecraft: net.Server
/** The host each Minecraft handshake named. */
const handshakeHosts: string[] = []

const MINECRAFT_STATUS = {
  version: { name: 'Paper 1.21.4', protocol: 769 },
  players: { max: 50, online: 7 },
  description: { text: '', extra: [{ text: '§aSurvival', bold: true }, { text: ' Server\n§7Second line' }] },
}

const frame = (id: number, ...fields: Buffer[]) => {
  const body = Buffer.concat([varInt(id), ...fields])
  return Buffer.concat([varInt(body.length), body])
}
const text = (value: string) => Buffer.concat([varInt(Buffer.byteLength(value)), Buffer.from(value)])
/** Each server's port, by what it pretends to be. */
const port: Record<string, number> = {}
/** How many info queries the Steam server answered with its full info. */
let infoReplies = 0

async function serve(name: string, answer: (message: Buffer) => Buffer | undefined): Promise<void> {
  const server = dgram.createSocket('udp4')
  server.on('message', (message, from) => {
    const reply = answer(message)
    if (reply) server.send(reply, from.port, from.address)
  })
  await new Promise<void>(resolve => server.bind(0, '127.0.0.1', resolve))
  servers.push(server)
  port[name] = (server.address() as AddressInfo).port
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})

  // A Steam server that, like every one since 2020, wants its challenge back.
  await serve('source', message => {
    if (!message.subarray(0, A2S_INFO.length).equals(A2S_INFO)) return undefined
    if (message.subarray(A2S_INFO.length).equals(CHALLENGE)) {
      infoReplies++
      return a2sInfoReply()
    }
    return Buffer.concat([OOB, Buffer.from([0x41]), CHALLENGE])
  })
  await serve('bedrock', message => (message[0] === 0x01 ? raknetPong(message) : undefined))
  await serve('quake', message =>
    message.toString('latin1').startsWith('\xff\xff\xff\xffgetinfo')
      ? Buffer.concat([OOB, Buffer.from('infoResponse\n\\sv_maxclients\\48\\clients\\12\\hostname\\^1Red ^7Roleplay\\gametype\\Freeroam\\mapname\\los_santos', 'utf8')])
      : undefined
  )
  await serve('echo', message => message)
  await serve('silent', () => undefined)

  // A Minecraft Java server, as the game's server list sees it: status, then
  // a pong with the ping's own bytes, then the connection closed.
  minecraft = net.createServer(socket => {
    let received: Buffer = Buffer.alloc(0)
    let handshake = false
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      for (let next = takePacket(received); next; next = takePacket(received)) {
        received = next.rest
        if (!handshake) {
          handshake = true
          // Protocol, then the host the player typed, which a proxy routes by.
          const protocol = readVarInt(next.body)!
          const length = readVarInt(next.body, protocol.size)!
          handshakeHosts.push(next.body.toString('utf8', protocol.size + length.size, protocol.size + length.size + length.value))
        } else if (next.id === 0x00) {
          socket.write(frame(0x00, text(JSON.stringify(MINECRAFT_STATUS))))
        } else if (next.id === 0x01) {
          socket.end(frame(0x01, next.body))
        }
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>(resolve => minecraft.listen(0, '127.0.0.1', resolve))
  port.minecraft = (minecraft.address() as AddressInfo).port
})

afterAll(() => {
  for (const server of servers) server.close()
  minecraft.close()
  vi.restoreAllMocks()
})

const quick = { count: 3, interval: 0, timeout: 500 }

describe('executeGameProbe', () => {
  it('times a Steam server, and sends its challenge back once to learn who it is', async () => {
    infoReplies = 0
    const result = await executeGameProbe('t', '127.0.0.1', { port: port.source, query: 'source', ...quick })

    expect(result).toMatchObject({ success: true, packetLoss: 0 })
    expect(result.latency).toBeGreaterThanOrEqual(0)
    expect(infoReplies).toBe(1)
    expect(result.details?.gameServer).toEqual({
      name: 'Big Rust Server | EU',
      game: 'Rust',
      map: 'Procedural Map',
      players: 42,
      maxPlayers: 100,
      version: '2589',
    })
  })

  it('reads a Minecraft Bedrock pong', async () => {
    const result = await executeGameProbe('t', '127.0.0.1', { port: port.bedrock, query: 'bedrock', ...quick })

    expect(result).toMatchObject({ success: true, packetLoss: 0 })
    expect(result.details?.gameServer).toEqual({
      name: 'Bedrock Realm',
      game: 'Minecraft Bedrock',
      map: 'Survival World',
      players: 3,
      maxPlayers: 20,
      version: '1.21.40',
    })
  })

  it('reads a FiveM getinfo answer, without its colour codes', async () => {
    const result = await executeGameProbe('t', '127.0.0.1', { port: port.quake, query: 'quake', ...quick })

    expect(result).toMatchObject({ success: true, packetLoss: 0 })
    expect(result.details?.gameServer).toEqual({
      name: 'Red Roleplay',
      game: 'Freeroam',
      map: 'los_santos',
      players: 12,
      maxPlayers: 48,
    })
  })

  it('counts a datagram that is not an answer as no answer', async () => {
    // The echo server sends the query straight back, which is not a pong.
    const result = await executeGameProbe('t', '127.0.0.1', { port: port.echo, query: 'bedrock', ...quick, timeout: 200 })

    expect(result).toMatchObject({ success: false, packetLoss: 100 })
  })

  it('says why a server that never answers failed', async () => {
    const result = await executeGameProbe('t', '127.0.0.1', { port: port.silent, query: 'source', ...quick, timeout: 200 })

    expect(result).toMatchObject({ success: false, packetLoss: 100, latency: null })
    expect(result.errorMessage).toMatch(/query port/)
  })

  // Linux hands a connected socket the ICMP "port unreachable" that comes back
  // from a closed port; Windows keeps it to itself, and there it is silence.
  it.runIf(process.platform === 'linux')('tells a closed port from a silent one', async () => {
    const closed = dgram.createSocket('udp4')
    await new Promise<void>(resolve => closed.bind(0, '127.0.0.1', resolve))
    const closedPort = (closed.address() as AddressInfo).port
    await new Promise<void>(resolve => closed.close(() => resolve()))

    const result = await executeGameProbe('t', '127.0.0.1', { port: closedPort, query: 'source', ...quick })

    expect(result).toMatchObject({ success: false, packetLoss: 100 })
    expect(result.errorMessage).toMatch(/Port unreachable/)
  })

  it('times a Minecraft Java server\'s ping, and reads its status once', async () => {
    handshakeHosts.length = 0
    const result = await executeGameProbe('t', '127.0.0.1', { port: port.minecraft, query: 'minecraft', ...quick })

    expect(result).toMatchObject({ success: true, packetLoss: 0 })
    expect(result.latency).toBeGreaterThanOrEqual(0)
    expect(handshakeHosts).toEqual(['127.0.0.1', '127.0.0.1', '127.0.0.1'])
    expect(result.details?.gameServer).toEqual({
      name: 'Survival Server',
      game: 'Minecraft Java',
      players: 7,
      maxPlayers: 50,
      version: 'Paper 1.21.4',
    })
  })

  it('says a TCP port nothing listens on is refused, for Minecraft Java', async () => {
    const closed = net.createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const closedPort = (closed.address() as AddressInfo).port
    await new Promise<void>(resolve => closed.close(() => resolve()))

    const result = await executeGameProbe('t', '127.0.0.1', { port: closedPort, query: 'minecraft', ...quick })
    expect(result).toMatchObject({ success: false, packetLoss: 100 })
    expect(result.errorMessage).toMatch(/refused/)
  })

  it('does not take something that is not Minecraft for a Minecraft server', async () => {
    // The echo server is UDP; a Steam query port is no TCP server at all, so
    // try one that answers with nonsense.
    const nonsense = net.createServer(socket => { socket.on('error', () => {}); socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') })
    await new Promise<void>(resolve => nonsense.listen(0, '127.0.0.1', resolve))
    const result = await executeGameProbe('t', '127.0.0.1', {
      port: (nonsense.address() as AddressInfo).port, query: 'minecraft', ...quick,
    })
    nonsense.close()
    expect(result).toMatchObject({ success: false, packetLoss: 100 })
  })

  // A server whose game answers nothing (Call of Duty and the like) is timed by
  // its "port unreachable" for ports nothing listens on, as mtr --udp does.
  it.runIf(process.platform === 'linux')('times a server by its "port unreachable", for a game with no query', async () => {
    const result = await executeGameProbe('t', '127.0.0.1', { port: port.silent, query: 'unreachable', ...quick })

    expect(result).toMatchObject({ success: true, packetLoss: 0 })
    expect(result.latency).toBeGreaterThanOrEqual(0)
    expect(result.details).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('says the "port unreachable" check needs Linux, rather than showing loss', async () => {
    const result = await executeGameProbe('t', '127.0.0.1', { port: port.silent, query: 'unreachable', ...quick })

    expect(result).toMatchObject({ success: false })
    expect(result.errorMessage).toMatch(/needs Linux/)
  })

  it('refuses a port or host it could never send to', async () => {
    expect(await executeGameProbe('t', '127.0.0.1', { port: 0, query: 'source' })).toMatchObject({ success: false, errorMessage: 'Invalid port: 0' })
    expect(await executeGameProbe('t', 'not a host', { port: 9, query: 'source' })).toMatchObject({ success: false })
  })
})
