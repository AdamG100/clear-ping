import { randomBytes } from 'crypto';
import type { GameServerInfo, UdpGameQuery } from '@/types/probe';

/**
 * The questions a game server probe puts over UDP, and how to read the answers.
 *
 * A UDP service has no handshake to time and usually ignores a datagram it
 * does not understand, so each format here is a real query the far end is
 * built to answer. They also say who is playing what, which a probe keeps as
 * the server's details.
 *
 * Pure apart from the random bytes in a request: no sockets, so the formats
 * can be tested against captured replies.
 */

export interface UdpQueryFormat {
  /** The datagram that asks. */
  request(): Buffer;
  /** Whether a datagram is an answer to it, rather than stray traffic. */
  isReply(reply: Buffer): boolean;
  /** What the reply says about the server, if it says anything. */
  read(reply: Buffer): GameServerInfo | undefined;
  /**
   * A second request a reply calls for before it will say more. A Steam
   * server answers its first query with a challenge to be sent back.
   */
  followUp?(reply: Buffer): Buffer | undefined;
}

/** The header every Steam and id Tech connectionless packet starts with. */
const OUT_OF_BAND = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/** Longest a name, map or version is kept. A server writes what it likes there. */
const MAX_TEXT = 200;

/** Text from a server, made safe to store and show: no control characters, no runaway length. */
function clean(text: string | undefined): string | undefined {
  const tidy = text?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_TEXT);
  return tidy || undefined;
}

function count(value: number | string | undefined): number | undefined {
  const number = typeof value === 'string' ? Number(value) : value;
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
}

/** Only the fields that were said: an empty object is no information. */
function infoOf(fields: GameServerInfo): GameServerInfo | undefined {
  const info = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as GameServerInfo;
  return Object.keys(info).length > 0 ? info : undefined;
}

/** Reads a packet field by field, and throws past its end, which the caller treats as "nothing to read". */
class Cursor {
  constructor(private readonly buffer: Buffer, private offset = 0) {}

  byte(): number {
    if (this.offset >= this.buffer.length) throw new RangeError('Past the end');
    return this.buffer[this.offset++];
  }

  skip(bytes: number): void {
    if (this.offset + bytes > this.buffer.length) throw new RangeError('Past the end');
    this.offset += bytes;
  }

  uint16le(): number {
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  /** A NUL-terminated string. */
  cstring(): string {
    const end = this.buffer.indexOf(0, this.offset);
    if (end === -1) throw new RangeError('Unterminated string');
    const text = this.buffer.toString('utf8', this.offset, end);
    this.offset = end + 1;
    return text;
  }
}

// ─── Steam (A2S_INFO) ───────────────────────────────────────────────────────

/** A2S_INFO, as every Source and Steam game server answers it. */
const A2S_INFO = Buffer.concat([OUT_OF_BAND, Buffer.from('TSource Engine Query\0', 'latin1')]);
const A2S_CHALLENGE = 0x41;
const A2S_INFO_REPLY = 0x49;
/** The Ship, which put three bytes of its own before the version. */
const THE_SHIP_APP_ID = 2400;

function readA2sInfo(reply: Buffer): GameServerInfo | undefined {
  if (reply.length < 6 || !reply.subarray(0, 4).equals(OUT_OF_BAND) || reply[4] !== A2S_INFO_REPLY) return undefined;
  try {
    const cursor = new Cursor(reply, 5);
    cursor.byte(); // protocol
    const name = cursor.cstring();
    const map = cursor.cstring();
    cursor.cstring(); // folder
    const game = cursor.cstring();
    const appId = cursor.uint16le();
    const players = cursor.byte();
    const maxPlayers = cursor.byte();
    cursor.skip(5); // bots, server type, environment, visibility, VAC
    if (appId === THE_SHIP_APP_ID) cursor.skip(3);
    const version = cursor.cstring();
    return infoOf({ name: clean(name), game: clean(game), map: clean(map), players, maxPlayers, version: clean(version) });
  } catch {
    return undefined;
  }
}

const source: UdpQueryFormat = {
  request: () => A2S_INFO,
  // 0xFE… is a reply split over several packets: still the server answering.
  isReply: reply => reply.length >= 5 && (reply.subarray(0, 4).equals(OUT_OF_BAND) || reply.readInt32LE(0) === -2),
  read: readA2sInfo,
  followUp: reply =>
    reply.length >= 9 && reply.subarray(0, 4).equals(OUT_OF_BAND) && reply[4] === A2S_CHALLENGE
      ? Buffer.concat([A2S_INFO, reply.subarray(5, 9)])
      : undefined,
};

// ─── Minecraft Bedrock (RakNet unconnected ping) ────────────────────────────

const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const RAKNET_PING = 0x01;
const RAKNET_PONG = 0x1c;
/** Pong id, ping time, server GUID, magic: what comes before the server's description. */
const RAKNET_PONG_HEADER = 1 + 8 + 8 + RAKNET_MAGIC.length;

function readRaknetPong(reply: Buffer): GameServerInfo | undefined {
  if (reply.length < RAKNET_PONG_HEADER + 2 || reply[0] !== RAKNET_PONG) return undefined;
  const length = reply.readUInt16BE(RAKNET_PONG_HEADER);
  const text = reply.toString('utf8', RAKNET_PONG_HEADER + 2, RAKNET_PONG_HEADER + 2 + length);
  // MCPE;name;protocol;version;players;max players;server id;level;game mode;…
  const [edition, name, , version, players, maxPlayers, , level] = text.split(';');
  if (edition !== 'MCPE' && edition !== 'MCEE') return undefined;
  return infoOf({
    name: clean(name),
    game: edition === 'MCEE' ? 'Minecraft Education' : 'Minecraft Bedrock',
    map: clean(level),
    players: count(players),
    maxPlayers: count(maxPlayers),
    version: clean(version),
  });
}

const bedrock: UdpQueryFormat = {
  request: () => {
    const time = Buffer.alloc(8);
    time.writeBigInt64BE(BigInt(Date.now()));
    return Buffer.concat([Buffer.from([RAKNET_PING]), time, RAKNET_MAGIC, randomBytes(8)]);
  },
  isReply: reply => reply.length >= RAKNET_PONG_HEADER && reply[0] === RAKNET_PONG,
  read: readRaknetPong,
};

// ─── id Tech getinfo (Quake 3, FiveM) ───────────────────────────────────────

const INFO_RESPONSE = 'infoResponse';

/** Quake colour codes, ^1 to ^9, which FiveM server names are full of. */
const COLOUR_CODE = /\^\d/g;

function readInfoResponse(reply: Buffer): GameServerInfo | undefined {
  if (!reply.subarray(0, 4).equals(OUT_OF_BAND)) return undefined;
  const text = reply.toString('utf8', 4);
  if (!text.startsWith(INFO_RESPONSE)) return undefined;

  // infoResponse\n\key\value\key\value…
  const pairs = text.slice(INFO_RESPONSE.length).trim().replace(/^\\/, '').split('\\');
  const values = new Map<string, string>();
  for (let i = 0; i + 1 < pairs.length; i += 2) values.set(pairs[i].toLowerCase(), pairs[i + 1]);

  const name = values.get('hostname') ?? values.get('sv_hostname');
  return infoOf({
    name: clean(name?.replace(COLOUR_CODE, '')),
    game: clean(values.get('gametype') ?? values.get('gamename')),
    map: clean(values.get('mapname')),
    players: count(values.get('clients')),
    maxPlayers: count(values.get('sv_maxclients')),
  });
}

const quake: UdpQueryFormat = {
  // The word after getinfo is a challenge the server repeats back; anything will do.
  request: () => Buffer.concat([OUT_OF_BAND, Buffer.from('getinfo clearping', 'latin1')]),
  isReply: reply => reply.length > 4 && reply.subarray(0, 4).equals(OUT_OF_BAND),
  read: readInfoResponse,
};

// ─── UDP echo (ping beacons) ────────────────────────────────────────────────

/** What an echo starts with, so a reply can be told from anything else the port sends. */
const ECHO_PREFIX = Buffer.from('clearping-echo:', 'latin1');

/**
 * A datagram for a server that sends back whatever it is sent: the UDP ping
 * beacons game hosts put up for exactly this, such as Amazon GameLift's on
 * port 7770. It says nothing about the server, only that it is there and how far.
 */
const echo: UdpQueryFormat = {
  request: () => Buffer.concat([ECHO_PREFIX, randomBytes(8)]),
  isReply: reply => reply.length === ECHO_PREFIX.length + 8 && reply.subarray(0, ECHO_PREFIX.length).equals(ECHO_PREFIX),
  read: () => undefined,
};

/** The format for a target's query. */
export function udpQueryFormat(query: UdpGameQuery): UdpQueryFormat {
  switch (query) {
    case 'echo':
      return echo;
    case 'source':
      return source;
    case 'bedrock':
      return bedrock;
    case 'quake':
      return quake;
  }
}
