import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { arch, hostname, platform } from 'node:os';
import type { ProbeIpVersion, ProbeResult, Traceroute } from '@/types/probe';
import { readingWorthLogging } from '@/lib/probes/log';
import { executeProbes, type ProbeTarget } from '@/lib/probes/probe';
import {
  PROBE_AGENT_MAX_BODY_BYTES,
  PROBE_AGENT_PROTOCOL,
  readProbeRequest,
  readTraceRequest,
  type ProbeAgentInfo,
} from '@/lib/probe-agents/protocol';
import { sameSecret } from '@/lib/security/secrets';
import { runTraceroute } from '@/lib/traceroute/run';

/**
 * The probe agent's HTTPS server: three routes, all behind the token.
 *
 *   GET  /v1/info        what this agent is, for pairing and health checks
 *   POST /v1/probe       one round of probing a target, as the dashboard would
 *   POST /v1/traceroute  one trace
 *   GET  /healthz        "ok", to this machine only (Docker's health check)
 *
 * It runs the dashboard's own probe code, so a reading taken here is the
 * same measurement a local one would be, only from somewhere else.
 */

/** Requests worked on at once. More wait for a free slot by being refused and retried next round. */
const MAX_IN_FLIGHT = 16;

/** Wrong tokens allowed from one address before it has to wait. */
const FREE_FAILURES = 10;
const MAX_LOCK_MS = 15 * 60 * 1000;

export interface ProbeAgentWork {
  probe(target: ProbeTarget): Promise<ProbeResult[]>;
  trace(target: { id: string; host: string }, ipVersion: ProbeIpVersion): Promise<Traceroute>;
}

export interface ProbeAgentOptions {
  token: string;
  key: string;
  cert: string;
  version: string;
  tools: ProbeAgentInfo['tools'];
  /** What actually runs. The real probes unless a test says otherwise. */
  work?: ProbeAgentWork;
  log?: (line: string) => void;
}

const REAL_WORK: ProbeAgentWork = {
  probe: executeProbes,
  trace: (target, ipVersion) => runTraceroute(target, 'manual', ipVersion),
};

class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > PROBE_AGENT_MAX_BODY_BYTES) {
        reject(new Refused(413, 'Request too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(new Refused(400, 'Request is not JSON'));
      }
    });
    request.on('error', reject);
  });
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

export function createProbeAgentServer(options: ProbeAgentOptions): Server {
  const work = options.work ?? REAL_WORK;
  const log = options.log ?? (() => {});
  const failures = new Map<string, { count: number; until: number }>();
  let inFlight = 0;

  const info = (): ProbeAgentInfo => ({
    version: options.version,
    protocol: PROBE_AGENT_PROTOCOL,
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    tools: options.tools,
  });

  /** Seconds this address must wait, or 0. */
  function lockedFor(address: string): number {
    const until = failures.get(address)?.until ?? 0;
    return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
  }

  function noteFailure(address: string): void {
    const entry = failures.get(address) ?? { count: 0, until: 0 };
    entry.count++;
    if (entry.count > FREE_FAILURES) {
      entry.until = Date.now() + Math.min(MAX_LOCK_MS, 1000 * 2 ** (entry.count - FREE_FAILURES));
    }
    failures.set(address, entry);
    // Bounded, whatever is thrown at it.
    if (failures.size > 10_000) failures.clear();
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = request.socket.remoteAddress ?? 'unknown';
    const path = (request.url ?? '/').split('?')[0];

    if (path === '/healthz' && request.method === 'GET') {
      // Only this machine may ask: anyone else learns nothing, not even that
      // this is a probe agent.
      if (isLoopback(address)) {
        response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      } else {
        send(response, 404, { error: 'Not found' });
      }
      return;
    }

    const wait = lockedFor(address);
    if (wait > 0) {
      send(response, 429, { error: 'Too many wrong tokens; try again later' }, { 'Retry-After': String(wait) });
      return;
    }

    const presented = bearer(request);
    if (!presented || !sameSecret(presented, options.token)) {
      noteFailure(address);
      log(`Refused a request from ${address}: wrong or missing token`);
      send(response, 401, { error: 'Wrong or missing token' });
      return;
    }
    failures.delete(address);

    if (path === '/v1/info' && request.method === 'GET') {
      send(response, 200, info());
      return;
    }

    if (request.method !== 'POST' || (path !== '/v1/probe' && path !== '/v1/traceroute')) {
      send(response, 404, { error: 'Not found' });
      return;
    }

    if (inFlight >= MAX_IN_FLIGHT) {
      send(response, 503, { error: 'Busy; try again shortly' }, { 'Retry-After': '5' });
      return;
    }

    inFlight++;
    try {
      const body = await readJson(request);

      if (path === '/v1/probe') {
        const asked = readProbeRequest(body);
        if (!asked.ok) throw new Refused(400, asked.error);
        const { target } = asked.value;
        const results = await work.probe(target);
        if (results.some(readingWorthLogging)) log(`${target.probeType} ${target.host}: ${results.map(r => (r.success ? `${r.latency}ms` : 'failed')).join(', ')}`);
        send(response, 200, { results });
      } else {
        const asked = readTraceRequest(body);
        if (!asked.ok) throw new Refused(400, asked.error);
        const trace = await work.trace(asked.value.target, asked.value.ipVersion);
        log(`traceroute ${asked.value.target.host}: ${trace.hops.length} hops`);
        send(response, 200, trace);
      }
    } finally {
      inFlight--;
    }
  }

  const server = createServer(
    {
      key: options.key,
      cert: options.cert,
      // Only ClearPing talks to this, and ClearPing speaks TLS 1.3.
      minVersion: 'TLSv1.3',
    },
    (request, response) => {
      handle(request, response).catch(error => {
        if (response.headersSent) return;
        if (error instanceof Refused) {
          send(response, error.status, { error: error.message });
        } else {
          log(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
          send(response, 500, { error: 'The probe could not be run' });
        }
      });
    }
  );

  // A slow client gets nowhere near the token check; a traceroute can take
  // up to 90 seconds per family.
  server.headersTimeout = 10_000;
  server.requestTimeout = 240_000;
  // The dashboard keeps its connection for the next reading, and lets go of it
  // first (CONNECTION_KEPT_MS in src/lib/probe-agents/client.ts).
  server.keepAliveTimeout = 120_000;
  return server;
}
