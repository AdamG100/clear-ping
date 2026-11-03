import dgram from 'dgram';
import type { GameQuery, GameServerInfo, ProbeIpVersion, ProbeResult, UdpGameQuery } from '@/types/probe';
import { udpQueryFormat, type UdpQueryFormat } from './game/query';
import { classifyHost, normalizeHost, type AddressFamily } from './host';
import { minecraftPing } from './game/minecraft';
import { elapsedSince, failedProbe, pause, summarizeProbe } from './result';
import { resolveHost } from './resolve';
import { logReading } from './log';

/**
 * Game server probe: asks a game server how it is, in the game's own query,
 * and times the answer.
 *
 * A game server says nothing to a packet it does not understand, so there is
 * nothing to time by just knocking on its port. Most of the queries go over
 * UDP (probes/game/query.ts); Minecraft Java's goes over TCP and has a ping of its
 * own (minecraft.ts), which is what is timed for it.
 *
 *   packetLoss = share of queries that got no answer
 *   latency    = mean time from asking to the answer
 *
 * Over UDP, a closed port and a silent one are told apart where the host says
 * so: a connected UDP socket hears the ICMP "port unreachable" that comes back
 * from a port nothing is listening on, and reports it as refused. Silence is
 * the other case, and the usual one for a game server asked on the wrong port
 * or in the wrong game's query.
 *
 * That same "port unreachable" is what times a server whose game answers
 * nothing to anyone outside a match (Call of Duty and the like) and which
 * blocks ping: sent to a port nothing listens on, a packet still gets an
 * answer from the server itself. It is the reply `mtr --udp` gets from its
 * last hop, though nothing here runs mtr: the packets are sent from here.
 * A server behind a firewall that drops them, as Google Cloud's does, sends
 * nothing back, and cannot be measured this way. Linux hands the answer to a
 * connected socket; Windows keeps it to itself.
 */

export interface GameProbeOptions {
  port: number;
  query: GameQuery;
  /** Queries per probe. */
  count?: number;
  /** Per-query timeout, in milliseconds. */
  timeout?: number;
  /** Delay between consecutive queries, in milliseconds. */
  interval?: number;
  /** Address family to resolve a domain target to. Ignored for IP literals. */
  ipVersion?: ProbeIpVersion;
}

/**
 * As many queries as a TCP probe has connections, spaced a little wider: game
 * servers limit how many queries one address may put, and a probe that trips
 * the limit would be measuring the limit.
 */
const DEFAULTS = {
  count: 10,
  timeout: 2000,
  interval: 200,
} as const;

/**
 * A second apart for the "port unreachable" check: a server answers only about
 * one a second after a short burst, and faster queries would count its own
 * limit as loss.
 */
const UNREACHABLE_INTERVAL = 1000;

/**
 * Where the "port unreachable" check sends: the ports traceroute uses, which
 * nothing listens on as a rule. One each query, in turn, as traceroute does.
 */
const CLOSED_PORT_BASE = 33434;

const PORT_UNREACHABLE = 'Port unreachable (the host says nothing is listening on it)';

const REASONS: Record<string, string> = {
  ECONNREFUSED: PORT_UNREACHABLE,
  // What Windows calls the same ICMP message.
  ECONNRESET: PORT_UNREACHABLE,
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
};

const UNREACHABLE_SILENCE =
  'No answer. The server, or a firewall in front of it (as on Google Cloud), drops packets to closed ports without replying';

const NO_REPLY: Record<UdpGameQuery, string> = {
  source: 'No reply. A Steam server only answers on its query port, which is not always the port players join on',
  bedrock: 'No reply to the Bedrock ping',
  quake: 'No reply to getinfo',
};

type Exchange = { ok: true; latency: number; reply?: Buffer } | { ok: false; error: string };
type Attempt = { ok: true; latency: number; info?: GameServerInfo } | { ok: false; error: string };

/** Send one datagram and wait for the reply to it. */
function exchange(
  address: string,
  family: AddressFamily,
  port: number,
  datagram: Buffer,
  format: UdpQueryFormat | null,
  timeoutMs: number,
  silence: string
): Promise<Exchange> {
  return new Promise(resolve => {
    const socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    let startedAt = performance.now();

    const finish = (attempt: Exchange) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      // A late error after close must not surface as an unhandled exception.
      socket.on('error', () => {});
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(attempt);
    };

    const timer = setTimeout(() => finish({ ok: false, error: silence }), timeoutMs);

    // Connected, so only the server's own datagrams arrive, and its ICMP
    // "port unreachable" comes back as an error rather than being lost.
    // With no format, the "port unreachable" is the answer being waited for,
    // and anything the port does send back shows the server is there as well.
    socket.on('message', reply => {
      if (!format || format.isReply(reply)) finish({ ok: true, latency: elapsedSince(startedAt), reply });
    });
    socket.on('error', (error: NodeJS.ErrnoException) =>
      !format && error.code === 'ECONNREFUSED'
        ? finish({ ok: true, latency: elapsedSince(startedAt) })
        : finish({ ok: false, error: REASONS[error.code ?? ''] ?? error.message })
    );
    socket.connect(port, address, () => {
      startedAt = performance.now();
      socket.send(datagram, error => {
        if (error) finish({ ok: false, error: REASONS[(error as NodeJS.ErrnoException).code ?? ''] ?? error.message });
      });
    });
  });
}

export async function executeGameProbe(
  targetId: string,
  host: string,
  options: GameProbeOptions
): Promise<ProbeResult> {
  const count = Math.max(1, Math.floor(options.count ?? DEFAULTS.count));
  const timeout = Math.max(100, Math.floor(options.timeout ?? DEFAULTS.timeout));
  const { port, query } = options;
  const interval = Math.max(0, Math.floor(options.interval ?? (query === 'unreachable' ? UNREACHABLE_INTERVAL : DEFAULTS.interval)));

  const timestamp = new Date();
  const trimmedHost = normalizeHost(host);
  const kind = classifyHost(trimmedHost);

  if (kind === 'invalid') return failedProbe(targetId, timestamp, `Invalid host: ${host}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return failedProbe(targetId, timestamp, `Invalid port: ${port}`);
  }
  if (query === 'unreachable' && process.platform === 'win32') {
    return failedProbe(
      targetId,
      timestamp,
      'This check needs Linux: Windows does not pass a server\'s "port unreachable" on. Run ClearPing, or a probe agent, on Linux'
    );
  }

  let address = trimmedHost;
  let family: AddressFamily = kind === 'ipv6' ? 6 : 4;

  // Resolved once, as for every other probe: each query of one probe should
  // be measuring the same server.
  if (kind === 'hostname') {
    const resolved = await resolveHost(trimmedHost, options.ipVersion);
    if (!resolved.ok) {
      console.log(`[Game] ${trimmedHost}:${port}: ${resolved.error}`);
      return failedProbe(targetId, timestamp, resolved.error);
    }
    address = resolved.address;
    family = resolved.family;
  }

  const udp = query === 'minecraft' || query === 'unreachable' ? null : { format: udpQueryFormat(query), silence: NO_REPLY[query] };
  let asked = 0;
  const latencies: number[] = [];
  let lastError: string | undefined;
  let lastReply: Buffer | undefined;
  let gameServer: GameServerInfo | undefined;

  const ask = async (): Promise<Attempt> => {
    if (query === 'unreachable') {
      const closedPort = CLOSED_PORT_BASE + (asked++ % 10);
      return exchange(address, family, closedPort, Buffer.from('clearping'), null, timeout, UNREACHABLE_SILENCE);
    }
    if (!udp) {
      // The name as typed goes in the handshake: a proxy in front of several
      // servers picks one by it. The status is asked for until it is known.
      return minecraftPing(address, family, trimmedHost, port, timeout, !gameServer);
    }
    const sent = await exchange(address, family, port, udp.format.request(), udp.format, timeout, udp.silence);
    if (!sent.ok) return sent;
    lastReply = sent.reply;
    return { ok: true, latency: sent.latency, info: sent.reply && udp.format.read(sent.reply) };
  };

  for (let i = 0; i < count; i++) {
    const attempt = await ask();

    if (attempt.ok) {
      latencies.push(attempt.latency);
      gameServer = attempt.info ?? gameServer;
    } else {
      lastError = attempt.error;
    }

    if (i < count - 1 && interval > 0) await pause(interval);
  }

  // A server that answers with a challenge says who it is only when the
  // challenge is sent back. Asked once a probe, and not timed: the replies
  // above already were.
  const followUp = udp && !gameServer && lastReply ? udp.format.followUp?.(lastReply) : undefined;
  if (udp && followUp) {
    const sent = await exchange(address, family, port, followUp, udp.format, timeout, udp.silence);
    if (sent.ok && sent.reply) gameServer = udp.format.read(sent.reply);
  }

  const result = summarizeProbe({
    targetId,
    timestamp,
    latencies,
    attempted: count,
    failureReason: lastError ?? udp?.silence ?? (query === 'unreachable' ? UNREACHABLE_SILENCE : 'No answer'),
    resolvedAddress: kind === 'hostname' ? address : undefined,
    details: gameServer ? { gameServer } : undefined,
  });

  logReading(
    result,
    `[Game] ${trimmedHost}:${port}${kind === 'hostname' ? ` (${address})` : ''} ${query}: ` +
    `queries=${count} answered=${latencies.length} loss=${result.packetLoss}% ` +
    `avg=${result.latency ?? '-'}ms jitter=${result.jitter ?? '-'}ms`
  );

  return result;
}
