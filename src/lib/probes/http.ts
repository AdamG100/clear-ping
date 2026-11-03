import http from 'http';
import https from 'https';
import type { LookupFunction } from 'net';
import type { TLSSocket } from 'tls';
import type { ProbeConfig, ProbeDetails, ProbeIpVersion, ProbeResult } from '@/types/probe';
import { classifyHost, normalizeHost } from './host';
import { mean, round } from './metrics';
import { httpUrlFor } from './config';
import { failedProbe, pause, summarizeProbe } from './result';
import { resolveHost, type ResolvedAddress } from './resolve';
import { logReading } from './log';

/**
 * HTTP(S) probe.
 *
 * Makes a real request and checks the answer, which is the only way to know a
 * website works: a host can answer pings and accept connections while serving
 * nothing but errors.
 *
 *   packetLoss = share of requests that failed or got the wrong answer
 *   latency    = mean time from starting a request to its first response byte
 *
 * Each request uses a fresh connection, so its time divides cleanly into
 * connect, TLS and waiting-for-the-server. Reusing a connection would make
 * every request after the first look faster than a visitor would ever see.
 *
 * Redirects are not followed. A redirect is an answer from the server being
 * watched; following it would measure some other server instead.
 */

export interface HttpOptions extends ProbeConfig {
  /** Requests per probe. */
  count?: number;
  /** Per-request timeout, in milliseconds. */
  timeout?: number;
  /** Delay between consecutive requests, in milliseconds. */
  interval?: number;
  /** Address family to resolve a domain target to. Ignored for IP literals. */
  ipVersion?: ProbeIpVersion;
}

/**
 * Deliberately few: these are requests to somebody's web server, not echoes a
 * kernel answers for free.
 */
const DEFAULTS = {
  count: 3,
  timeout: 10_000,
  interval: 250,
} as const;

/** Enough of a page to find a keyword in, without downloading a large one whole. */
const MAX_BODY_BYTES = 512 * 1024;

interface Timings {
  /** Request start to first response byte. */
  total: number;
  connect?: number;
  tls?: number;
  wait?: number;
}

type RequestOutcome =
  | { ok: true; statusCode: number; timings: Timings; certExpiresAt?: number }
  | { ok: false; error: string; statusCode?: number; certExpiresAt?: number };

/**
 * Hand the request the address that was already resolved, instead of letting
 * it look the name up again. The request still knows the real hostname, so the
 * Host header, SNI and certificate check are all against the name.
 */
function pinnedLookup(resolved: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address: resolved.address, family: resolved.family }]);
    } else {
      callback(null, resolved.address, resolved.family);
    }
  };
}

function isExpectedStatus(statusCode: number, expected: number | undefined): boolean {
  return expected === undefined ? statusCode >= 200 && statusCode < 400 : statusCode === expected;
}

function requestOnce(
  url: URL,
  config: ProbeConfig,
  resolved: ResolvedAddress | null,
  family: 4 | 6 | undefined,
  timeoutMs: number
): Promise<RequestOutcome> {
  return new Promise(resolve => {
    const startedAt = performance.now();
    let connectedAt: number | undefined;
    let secureAt: number | undefined;
    let settled = false;
    let certExpiresAt: number | undefined;

    const settle = (outcome: RequestOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.destroy();
      resolve(outcome);
    };

    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET',
      // No connection reuse; see the module comment.
      agent: false,
      family,
      lookup: resolved ? pinnedLookup(resolved) : undefined,
      headers: {
        'User-Agent': 'ClearPing (uptime monitor)',
        Accept: '*/*',
        // Asking for an uncompressed body keeps the keyword search honest.
        'Accept-Encoding': 'identity',
      },
    });

    // One deadline for the whole request, rather than the socket's idle
    // timeout: a server that trickles a byte every few seconds never goes idle.
    const deadline = setTimeout(
      () => settle({ ok: false, error: `No response within ${timeoutMs / 1000}s`, certExpiresAt }),
      timeoutMs
    );

    request.on('socket', socket => {
      socket.once('connect', () => { connectedAt = performance.now(); });
      socket.once('secureConnect', () => {
        secureAt = performance.now();
        const validTo = Date.parse((socket as TLSSocket).getPeerCertificate().valid_to);
        if (Number.isFinite(validTo)) certExpiresAt = validTo;
      });
    });

    request.on('error', error => settle({ ok: false, error: error.message, certExpiresAt }));

    request.on('response', response => {
      const firstByteAt = performance.now();
      const statusCode = response.statusCode ?? 0;

      const timings: Timings = { total: round(firstByteAt - startedAt, 2) };
      if (connectedAt !== undefined) {
        timings.connect = round(connectedAt - startedAt, 2);
        if (secureAt !== undefined) timings.tls = round(secureAt - connectedAt, 2);
        timings.wait = round(firstByteAt - (secureAt ?? connectedAt), 2);
      }

      if (!isExpectedStatus(statusCode, config.expectedStatus)) {
        settle({
          ok: false,
          statusCode,
          certExpiresAt,
          error: config.expectedStatus === undefined
            ? `HTTP ${statusCode}`
            : `HTTP ${statusCode} (expected ${config.expectedStatus})`,
        });
        return;
      }

      // Without a keyword the headers are the whole answer; the body is not
      // downloaded at all.
      if (!config.keyword) {
        settle({ ok: true, statusCode, timings, certExpiresAt });
        return;
      }

      const keyword = config.keyword;
      const chunks: Buffer[] = [];
      let received = 0;

      const judge = () => {
        const found = Buffer.concat(chunks).toString('utf8').includes(keyword);
        settle(
          found
            ? { ok: true, statusCode, timings, certExpiresAt }
            : { ok: false, statusCode, certExpiresAt, error: `Response did not contain "${keyword}"` }
        );
      };

      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        received += chunk.length;
        if (received >= MAX_BODY_BYTES) judge();
      });
      response.on('end', judge);
      response.on('error', error => settle({ ok: false, statusCode, certExpiresAt, error: error.message }));
    });

    request.end();
  });
}

export async function executeHttpProbe(
  targetId: string,
  host: string,
  options: HttpOptions = {}
): Promise<ProbeResult> {
  const count = Math.max(1, Math.floor(options.count ?? DEFAULTS.count));
  const timeout = Math.max(500, Math.floor(options.timeout ?? DEFAULTS.timeout));
  const interval = Math.max(0, Math.floor(options.interval ?? DEFAULTS.interval));

  const timestamp = new Date();
  const trimmedHost = normalizeHost(host);
  const kind = classifyHost(trimmedHost);

  if (kind === 'invalid') return failedProbe(targetId, timestamp, `Invalid host: ${host}`);

  let url: URL;
  try {
    url = new URL(httpUrlFor(trimmedHost, options));
  } catch {
    return failedProbe(targetId, timestamp, `Invalid URL for ${host}`);
  }

  let resolved: ResolvedAddress | null = null;
  if (kind === 'hostname') {
    const outcome = await resolveHost(trimmedHost, options.ipVersion);
    if (!outcome.ok) {
      console.log(`[HTTP] ${url.href}: ${outcome.error}`);
      return failedProbe(targetId, timestamp, outcome.error);
    }
    resolved = outcome;
  }
  const family = resolved?.family ?? (kind === 'ipv6' ? 6 : kind === 'ipv4' ? 4 : undefined);

  const latencies: number[] = [];
  const phases: Timings[] = [];
  let lastError: string | undefined;
  let statusCode: number | undefined;
  let certExpiresAt: number | undefined;

  for (let i = 0; i < count; i++) {
    const outcome = await requestOnce(url, options, resolved, family, timeout);

    statusCode = outcome.statusCode ?? statusCode;
    certExpiresAt = outcome.certExpiresAt ?? certExpiresAt;

    if (outcome.ok) {
      latencies.push(outcome.timings.total);
      phases.push(outcome.timings);
    } else {
      lastError = outcome.error;
    }

    if (i < count - 1 && interval > 0) await pause(interval);
  }

  const phaseMean = (pick: (timings: Timings) => number | undefined) => {
    const value = mean(phases.map(pick).filter((v): v is number => v !== undefined));
    return value === null ? undefined : round(value, 2);
  };

  const details: ProbeDetails = {
    statusCode,
    connectMs: phaseMean(t => t.connect),
    tlsMs: phaseMean(t => t.tls),
    waitMs: phaseMean(t => t.wait),
    certExpiresAt,
  };

  const result = summarizeProbe({
    targetId,
    timestamp,
    latencies,
    attempted: count,
    failureReason: lastError ?? 'All requests failed',
    resolvedAddress: resolved?.address,
    details,
  });

  logReading(
    result,
    `[HTTP] ${url.href}${resolved ? ` (${resolved.address})` : ''}: ` +
    `requests=${count} ok=${latencies.length} status=${statusCode ?? '-'} ` +
    `loss=${result.packetLoss}% avg=${result.latency ?? '-'}ms`
  );

  return result;
}
