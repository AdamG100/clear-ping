import { Resolver } from 'dns/promises';
import http from 'http';
import http2 from 'http2';
import https from 'https';
import net, { isIP } from 'net';
import tls from 'tls';
import type { DnsRecordType, DnsResolver } from '@/types/probe';
import { parseDohServer, parseDotServer } from './dns-resolvers';
import { RCODE_NXDOMAIN, decodeReply, encodeQuery, frameMessage, rcodeName, unframeMessage } from './dns-wire';
import { elapsedSince } from './probe-result';
import { resolveHost } from './resolve';

/**
 * Asking one resolver one question, over whichever way it is asked.
 *
 * Each protocol is opened once and then asked repeatedly, because that is how
 * it is used. A browser speaking DNS over HTTPS keeps its connection to the
 * resolver open and sends every lookup down it, and a system doing DNS over
 * TLS does the same. Timing a fresh TLS handshake for every question would
 * measure something nobody waits for, and make an encrypted resolver look
 * several times slower than it is. So the connection is opened once, the time
 * that took is reported by itself, and the questions that follow are timed
 * alone.
 */

export type QueryOutcome = { answered: true; answers: string[] } | { answered: false; error: string };

export interface ResolverSession {
  /** dot, doh: how long the connection took to open, in milliseconds. */
  connectMs?: number;
  query: () => Promise<QueryOutcome>;
  /** Let go of the connection. Safe to call once the questions are done. */
  close: () => void;
}

/** Node's names for "no such name" and "no record of that type": answers, not failures. */
const NEGATIVE_ANSWERS = new Set(['ENOTFOUND', 'ENODATA']);

function reasonFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A reply taken apart, as the outcome of the query that got it. */
function outcomeOf(message: Buffer, recordType: DnsRecordType): QueryOutcome {
  const reply = decodeReply(message, recordType);
  if (reply.rcode === 0 || reply.rcode === RCODE_NXDOMAIN) return { answered: true, answers: reply.answers };
  return { answered: false, error: `Resolver answered ${rcodeName(reply.rcode)}` };
}

// ─── Plain DNS ──────────────────────────────────────────────────────────────

/**
 * Plain DNS to one server's address, bypassing the system resolver entirely so
 * the timing is that server's and nobody else's cache.
 */
function plainSession(server: string, name: string, recordType: DnsRecordType, timeout: number): ResolverSession {
  // The resolver enforces `timeout` itself, so there is no dangling timer left
  // running after a fast answer.
  const resolver = new Resolver({ timeout, tries: 1 });
  resolver.setServers([server]);

  return {
    query: async () => {
      try {
        return { answered: true, answers: flattenAnswers(await resolver.resolve(name, recordType)) };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && NEGATIVE_ANSWERS.has(code)) return { answered: true, answers: [] };
        // In the words the other two protocols use for the same thing: left
        // as the library has it, a timeout reads "queryA ETIMEOUT example.com".
        const reason: Record<string, string> = {
          ETIMEOUT: `No answer within ${timeout}ms`,
          ESERVFAIL: 'Resolver answered SERVFAIL',
          EREFUSED: 'Resolver answered REFUSED',
          ECONNREFUSED: 'Connection refused: nothing is answering DNS at this address',
        };
        return { answered: false, error: (code && reason[code]) || reasonFor(error, 'DNS query failed') };
      }
    },
    close: () => resolver.cancel(),
  };
}

/** Reduce whatever shape a record type comes back in to comparable strings. */
export function flattenAnswers(records: unknown): string[] {
  if (!Array.isArray(records)) return [];

  return records.map(record => {
    if (typeof record === 'string') return record;
    // TXT records arrive as arrays of chunks that belong together.
    if (Array.isArray(record)) return record.join('');
    if (record && typeof record === 'object') {
      const fields = record as Record<string, unknown>;
      // MX carries a priority alongside the name that matters.
      return String(fields.exchange ?? fields.value ?? fields.address ?? JSON.stringify(fields));
    }
    return String(record);
  });
}

// ─── The system resolver ────────────────────────────────────────────────────

/**
 * The system resolver.
 *
 * Deliberately the same path every other program on the machine takes — hosts
 * file, VPN or encrypted-DNS client and OS cache included — rather than a
 * direct query to whichever servers the DNS library believes are configured.
 * On machines where a local proxy or VPN handles DNS that list is wrong, and
 * every direct query was refused while the name resolved fine for everything
 * else.
 *
 * That path only ever answers with addresses, so an address is all the system
 * resolver can be asked for. A target that wants another kind of record names
 * the resolvers to ask, and they are asked directly.
 */
function systemSession(name: string, recordType: DnsRecordType, timeout: number): ResolverSession {
  if (recordType !== 'A' && recordType !== 'AAAA') {
    throw new Error(`The system resolver only looks up addresses, not ${recordType} records`);
  }

  return {
    query: async () => {
      const resolved = await resolveHost(name, recordType === 'A' ? 'ipv4' : 'ipv6', { timeoutMs: timeout });
      return resolved.ok
        ? { answered: true, answers: resolved.addresses }
        : { answered: false, error: resolved.error };
    },
    close: () => {},
  };
}

// ─── DNS over TLS ───────────────────────────────────────────────────────────

/**
 * DNS over TLS (RFC 7858): the ordinary message, its length in front of it,
 * down a TLS connection to port 853.
 */
async function dotSession(
  server: string,
  name: string,
  recordType: DnsRecordType,
  timeout: number
): Promise<ResolverSession> {
  const where = parseDotServer(server);
  if (!where) throw new Error(`${server} is not a DNS over TLS resolver`);

  const startedAt = performance.now();
  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const connecting = tls.connect({
      host: where.host,
      port: where.port,
      // A certificate is issued to a name. Reached by address, the address
      // itself is what the certificate has to cover.
      servername: isIP(where.host) ? undefined : where.host,
      ALPNProtocols: ['dot'],
    });
    const timer = setTimeout(() => {
      connecting.destroy();
      reject(new Error(`No TLS connection to ${where.host} within ${timeout}ms`));
    }, timeout);

    connecting.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(connecting);
    });
    connecting.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const connectMs = elapsedSince(startedAt);

  // One question at a time, so what arrives next is the reply to it.
  let received: Buffer = Buffer.alloc(0);
  let waiting: { resolve: (message: Buffer) => void; reject: (error: Error) => void } | null = null;
  let closedBy: Error | null = null;

  const fail = (error: Error) => {
    closedBy = closedBy ?? error;
    waiting?.reject(closedBy);
    waiting = null;
  };

  socket.on('data', (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    const framed = unframeMessage(received);
    if (!framed || !waiting) return;
    received = Buffer.from(framed.rest);
    waiting.resolve(framed.message);
    waiting = null;
  });
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Resolver closed the connection')));

  const exchange = (message: Buffer) =>
    new Promise<Buffer>((resolve, reject) => {
      if (closedBy) {
        reject(closedBy);
        return;
      }
      const timer = setTimeout(() => {
        waiting = null;
        // The reply may still arrive, and would then be read as the answer to
        // the next question. The connection is of no more use, and the
        // questions still to come fail for the reason this one did.
        closedBy = new Error(`No answer within ${timeout}ms`);
        socket.destroy();
        reject(closedBy);
      }, timeout);

      waiting = {
        resolve: reply => { clearTimeout(timer); resolve(reply); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      socket.write(frameMessage(message));
    });

  let nextId = Math.floor(Math.random() * 0xffff);

  return {
    connectMs,
    query: async () => {
      try {
        nextId = (nextId + 1) & 0xffff;
        return outcomeOf(await exchange(encodeQuery(name, recordType, nextId)), recordType);
      } catch (error) {
        return { answered: false, error: reasonFor(error, 'DNS over TLS query failed') };
      }
    },
    close: () => socket.destroy(),
  };
}

// ─── DNS over HTTPS ─────────────────────────────────────────────────────────

const DNS_MESSAGE = 'application/dns-message';
/** A reply that fits a DNS message many times over; anything longer is not one. */
const MAX_DOH_REPLY_BYTES = 65_535;

/** Open the connection a DNS over HTTPS resolver is asked down, and say which HTTP it agreed to. */
function connectDoh(url: URL, timeout: number): Promise<{ socket: net.Socket; http2: boolean }> {
  const secure = url.protocol === 'https:';
  const port = Number(url.port) || (secure ? 443 : 80);
  // `URL` keeps the brackets on an IPv6 host; a socket wants it bare.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({
          host,
          port,
          servername: isIP(host) ? undefined : host,
          // HTTP/2 first: it is what the standard asks for, and some resolvers
          // answer nothing else.
          ALPNProtocols: ['h2', 'http/1.1'],
        })
      : net.connect({ host, port });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No connection to ${host} within ${timeout}ms`));
    }, timeout);

    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve({ socket, http2: secure && (socket as tls.TLSSocket).alpnProtocol === 'h2' });
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Gather a reply's body, refusing one too long to be a DNS message. */
function collectReply(
  stream: NodeJS.ReadableStream,
  status: () => number | undefined,
  resolve: (reply: Buffer) => void,
  reject: (error: Error) => void
) {
  const chunks: Buffer[] = [];
  let size = 0;

  stream.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_DOH_REPLY_BYTES) chunks.push(chunk);
  });
  stream.on('error', reject);
  stream.on('end', () => {
    if (status() !== 200) reject(new Error(`Resolver answered HTTP ${status() ?? 'nothing'}`));
    else if (size > MAX_DOH_REPLY_BYTES) reject(new Error('Resolver sent more than a DNS reply holds'));
    else resolve(Buffer.concat(chunks));
  });
}

/**
 * DNS over HTTPS (RFC 8484): the ordinary message as the body of a POST, down
 * a connection that is opened once and kept. HTTP/2 where the resolver speaks
 * it, which is nearly all of them, and HTTP/1.1 where it does not.
 */
async function dohSession(
  server: string,
  name: string,
  recordType: DnsRecordType,
  timeout: number
): Promise<ResolverSession> {
  const url = parseDohServer(server);
  if (!url) throw new Error(`${server} is not a DNS over HTTPS resolver`);

  const startedAt = performance.now();
  const connection = await connectDoh(url, timeout);
  const connectMs = elapsedSince(startedAt);

  // The id is zero for every question, as the standard asks, so that the same
  // question is the same request to any cache in between.
  const body = encodeQuery(name, recordType, 0);
  const headers = { 'content-type': DNS_MESSAGE, accept: DNS_MESSAGE, 'content-length': body.length };

  let exchange: () => Promise<Buffer>;
  let close: () => void;

  if (connection.http2) {
    const session = http2.connect(url.origin, { createConnection: () => connection.socket });
    // Without a listener a broken connection would be an uncaught error; each
    // question finds out for itself when it is asked.
    session.on('error', () => {});

    exchange = () =>
      new Promise<Buffer>((resolve, reject) => {
        if (session.closed || session.destroyed) {
          reject(new Error('Resolver closed the connection'));
          return;
        }

        const stream = session.request({ ':method': 'POST', ':path': url.pathname + url.search, ...headers });
        let status: number | undefined;

        stream.setTimeout(timeout, () => {
          stream.close(http2.constants.NGHTTP2_CANCEL);
          reject(new Error(`No answer within ${timeout}ms`));
        });
        stream.on('response', responseHeaders => {
          status = Number(responseHeaders[':status']);
        });
        collectReply(stream, () => status, resolve, reject);
        stream.end(body);
      });
    close = () => session.destroy();
  } else {
    const secure = url.protocol === 'https:';
    const agent = secure
      ? new https.Agent({ keepAlive: true, maxSockets: 1 })
      : new http.Agent({ keepAlive: true, maxSockets: 1 });
    // The connection already opened is the one the agent is to use, and being
    // kept alive it is the one every question goes down. Set on the agent: a
    // request's own `createConnection` is ignored once it has an agent.
    Object.assign(agent, { createConnection: () => connection.socket });
    let gaveUp: Error | null = null;

    exchange = () =>
      new Promise<Buffer>((resolve, reject) => {
        // Once the one connection is gone there is nothing to ask down, and
        // the agent would be handed the same dead socket again. Given up on,
        // the questions still to come fail for the reason the first did.
        if (gaveUp || connection.socket.destroyed) {
          reject(gaveUp ?? new Error('Resolver closed the connection'));
          return;
        }

        const request = (secure ? https : http).request(
          url,
          { method: 'POST', agent, headers },
          response => collectReply(response, () => response.statusCode, finish(resolve), finish(reject))
        );
        // Timed here and not by the socket: a socket that was already open
        // when the request was given it is never told the request's timeout.
        const timer = setTimeout(() => {
          gaveUp = new Error(`No answer within ${timeout}ms`);
          request.destroy(gaveUp);
        }, timeout);
        const finish = <T,>(settle: (value: T) => void) => (value: T) => {
          clearTimeout(timer);
          settle(value);
        };

        request.on('error', finish(reject));
        request.end(body);
      });
    close = () => {
      agent.destroy();
      connection.socket.destroy();
    };
  }

  return {
    connectMs,
    query: async () => {
      try {
        return outcomeOf(await exchange(), recordType);
      } catch (error) {
        return { answered: false, error: reasonFor(error, 'DNS over HTTPS query failed') };
      }
    },
    close,
  };
}

// ─── Opening one ────────────────────────────────────────────────────────────

/**
 * Get ready to ask `resolver` for the `recordType` record of `name`. Throws if
 * the resolver cannot be reached at all, which is every question failed.
 */
export async function openResolverSession(
  resolver: DnsResolver,
  name: string,
  recordType: DnsRecordType,
  timeout: number
): Promise<ResolverSession> {
  switch (resolver.protocol) {
    case 'system':
      return systemSession(name, recordType, timeout);
    case 'udp':
      return plainSession(resolver.server ?? '', name, recordType, timeout);
    case 'dot':
      return dotSession(resolver.server ?? '', name, recordType, timeout);
    case 'doh':
      return dohSession(resolver.server ?? '', name, recordType, timeout);
  }
}
