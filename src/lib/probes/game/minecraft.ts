import net from 'net';
import { randomBytes } from 'crypto';
import type { GameServerInfo } from '@/types/probe';
import type { AddressFamily } from '../host';
import { elapsedSince } from '../result';

/**
 * Minecraft Java's server list ping: what the game's multiplayer screen does
 * to show a server's message, player count and ping.
 *
 * Over TCP, unlike the other game queries. One connection asks for the
 * server's status, then sends a ping that the server answers with the same
 * eight bytes; the time between the two is the server's ping, measured as
 * the game measures it. The server closes the connection after the pong, so
 * each ping is a connection of its own.
 *
 *   → handshake (protocol, host, port, next state: status)
 *   → status request          ← status (JSON)
 *   → ping (8 bytes)          ← pong (the same 8 bytes)
 *
 * Every packet is its length as a VarInt, then its id as a VarInt, then its fields.
 */

/** Any protocol number will do for a status ping; -1 is what tools that are not the game send. */
const ANY_PROTOCOL = -1;
const STATUS_STATE = 1;
/** Largest status a server is let send: its icon alone can be some tens of kilobytes. */
const MAX_PACKET = 256 * 1024;
const MAX_TEXT = 200;

export function varInt(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return Buffer.from(bytes);
}

/** A VarInt at `offset`, and how many bytes it took; null if the buffer ends first. */
export function readVarInt(buffer: Buffer, offset = 0): { value: number; size: number } | null {
  let value = 0;
  for (let size = 0; size < 5; size++) {
    if (offset + size >= buffer.length) return null;
    const byte = buffer[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    if ((byte & 0x80) === 0) return { value, size: size + 1 };
  }
  throw new Error('VarInt too long');
}

function packet(id: number, ...fields: Buffer[]): Buffer {
  const body = Buffer.concat([varInt(id), ...fields]);
  return Buffer.concat([varInt(body.length), body]);
}

function text(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([varInt(bytes.length), bytes]);
}

/**
 * The handshake and status request, sent together. The host is the name the
 * player typed: a proxy in front of several servers picks one by it.
 */
export function statusRequest(host: string, port: number): Buffer {
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return Buffer.concat([
    packet(0x00, varInt(ANY_PROTOCOL), text(host), portBytes, varInt(STATUS_STATE)),
    packet(0x00),
  ]);
}

export function pingPacket(payload: Buffer): Buffer {
  return packet(0x01, payload);
}

/** One whole packet from the front of what has arrived, or null until it is all there. */
export function takePacket(buffer: Buffer): { id: number; body: Buffer; rest: Buffer } | null {
  const length = readVarInt(buffer);
  if (!length) return null;
  if (length.value > MAX_PACKET) throw new Error('The server sent a packet too big to be a status');
  const end = length.size + length.value;
  if (buffer.length < end) return null;
  const inner = buffer.subarray(length.size, end);
  const id = readVarInt(inner);
  if (!id) throw new Error('Empty packet');
  return { id: id.value, body: inner.subarray(id.size), rest: buffer.subarray(end) };
}

interface Chat {
  text?: string;
  extra?: Chat[];
}

/** A message of the game's own kind, as plain text: its parts joined, its colour codes taken out. */
function plain(message: unknown): string {
  const flatten = (part: unknown): string =>
    typeof part === 'string' ? part : part && typeof part === 'object' ? `${(part as Chat).text ?? ''}${((part as Chat).extra ?? []).map(flatten).join('')}` : '';
  return flatten(message).replace(/§./g, '');
}

function clean(value: string | undefined): string | undefined {
  const tidy = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  return tidy || undefined;
}

const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

/** What a status packet says about the server. */
export function readStatus(body: Buffer): GameServerInfo | undefined {
  const length = readVarInt(body);
  if (!length) return undefined;
  let status: { description?: unknown; players?: { online?: unknown; max?: unknown }; version?: { name?: unknown } };
  try {
    status = JSON.parse(body.toString('utf8', length.size, length.size + length.value));
  } catch {
    return undefined;
  }
  const info: GameServerInfo = {
    // The first line of the message is the one the server list shows as its name.
    name: clean(plain(status.description).split('\n')[0]),
    game: 'Minecraft Java',
    players: count(status.players?.online),
    maxPlayers: count(status.players?.max),
    version: clean(typeof status.version?.name === 'string' ? status.version.name.replace(/§./g, '') : undefined),
  };
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) as GameServerInfo;
}

export type MinecraftAttempt = { ok: true; latency: number; info?: GameServerInfo } | { ok: false; error: string };

const REASONS: Record<string, string> = {
  ECONNREFUSED: 'Connection refused (nothing is listening on the port)',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  ECONNRESET: 'Connection reset',
};

/**
 * One server list ping: connect, ask for the status, then time a ping. The
 * status is read only when asked for, since it is the same every time and a
 * probe needs it once.
 */
export function minecraftPing(
  address: string,
  family: AddressFamily,
  host: string,
  port: number,
  timeoutMs: number,
  readInfo: boolean
): Promise<MinecraftAttempt> {
  return new Promise(resolve => {
    const socket = net.connect({ host: address, port, family });
    const payload = randomBytes(8);
    let received: Buffer = Buffer.alloc(0);
    let info: GameServerInfo | undefined;
    let pingedAt: number | null = null;

    const finish = (attempt: MinecraftAttempt) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      // A late error after destroy must not surface as an unhandled exception.
      socket.on('error', () => {});
      socket.destroy();
      resolve(attempt);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: pingedAt === null ? 'No status in time: is this a Minecraft Java server?' : 'No pong in time' }),
      timeoutMs
    );

    socket.once('connect', () => socket.write(statusRequest(host, port)));
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      try {
        for (let next = takePacket(received); next; next = takePacket(received)) {
          received = next.rest;
          if (next.id === 0x00 && pingedAt === null) {
            if (readInfo) info = readStatus(next.body);
            pingedAt = performance.now();
            socket.write(pingPacket(payload));
          } else if (next.id === 0x01 && pingedAt !== null && next.body.subarray(0, 8).equals(payload)) {
            finish({ ok: true, latency: elapsedSince(pingedAt), info });
            return;
          }
        }
      } catch (error) {
        finish({ ok: false, error: `Not a Minecraft Java status: ${(error as Error).message}` });
      }
    });
    socket.once('close', () =>
      finish({ ok: false, error: pingedAt === null ? 'The server closed the connection without a status' : 'The server closed the connection before its pong' })
    );
    socket.once('error', (error: NodeJS.ErrnoException) => finish({ ok: false, error: REASONS[error.code ?? ''] ?? error.message }));
  });
}
