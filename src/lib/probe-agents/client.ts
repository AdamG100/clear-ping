import { lookup } from 'dns/promises';
import https from 'https';
import { isIP } from 'net';
import tls from 'tls';
import type { ProbeIpVersion, ProbeResult, Target, Traceroute } from '@/types/probe';
import { LOCAL_PROBE, type ProbeAgentExposure, type ProbeAgentState, type ProbeId } from '@/types/probe-agent';
import { executeProbes, type ProbeTarget } from '../probes/probe';
import { configForProbe } from '../targets/resolver-probes';
import { primaryProbeOf } from '../targets/probes';
import { exposureOfAddress, isTailnetAddress } from './exposure';
import {
  PROBE_AGENT_PROTOCOL,
  isProbeAgentInfo,
  reviveResults,
  reviveTrace,
  type ProbeAgentInfo,
} from './protocol';
import {
  getProbeAgentConnection,
  pinProbeAgentCertificate,
  setProbeAgentState,
  unpinProbeAgentCertificate,
  type ProbeAgentConnection,
} from './store';
import { isPrivateAddress } from '../probes/host';
import { runTraceroute } from '../traceroute/run';

/**
 * Talking to probe agents.
 *
 * Every request goes over TLS to the one certificate pinned for that agent
 * and carries its token; the token is only ever sent once the certificate has
 * been checked. The first certificate an agent presents is the one pinned
 * (as SSH does with a new host), and its fingerprint is shown so it can be
 * compared with the one the agent logged when it started.
 */

/** Long enough for a slow link, short enough that a dead agent is noticed within a round. */
const CONNECT_TIMEOUT_MS = 10_000;
/** A round of pings is 20 packets a second apart, over two families at most. */
const PROBE_TIMEOUT_MS = 120_000;
/** Each family is traced one after the other, up to 90 seconds each. */
const TRACE_TIMEOUT_MS = 200_000;
const INFO_TIMEOUT_MS = 15_000;
/** How long a connection to a probe agent is kept with nothing to ask. Past the longest usual interval, and short of how long the agent keeps it (probe-agent/server.ts). */
const CONNECTION_KEPT_MS = 90_000;

/**
 * A round that could not be taken because of the probe agent, not the target.
 * Nothing is recorded for it. `state` is what that says about the agent, or
 * absent for a hiccup that says nothing (it was busy, say).
 */
export class ProbeAgentUnavailableError extends Error {
  constructor(
    readonly agentName: string,
    message: string,
    readonly state?: ProbeAgentState,
    readonly offeredFingerprint?: string
  ) {
    super(message);
    this.name = 'ProbeAgentUnavailableError';
  }
}

/** Connections kept open to one probe agent: as many as it is asked at once (see the scheduler's lane for it). */
const AGENT_CONNECTIONS_KEPT = 4;

const CERTIFICATE_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_PINNED_MISMATCH',
]);

function sniFor(address: string): string | undefined {
  return isIP(address) ? undefined : address;
}

function plainReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return 'Nothing is listening on that port';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'The address cannot be reached from here';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'The name does not resolve';
    case 'ECONNRESET':
      return 'The connection was dropped';
    case 'ETIMEDOUT':
      return 'No answer in time';
  }
  return error instanceof Error ? error.message : String(error);
}

/** The certificate an agent presents, read from the TLS handshake alone: nothing is sent. */
export function presentedCertificate(address: string, port: number): Promise<{ pem: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: address,
      port,
      servername: sniFor(address),
      // Read, not trusted: what to do with it is decided by the caller.
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    });
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('No answer in time'), { code: 'ETIMEDOUT' })), CONNECT_TIMEOUT_MS);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = socket.getPeerX509Certificate();
      socket.end();
      if (!cert) reject(new Error('It presented no certificate'));
      else resolve({ pem: cert.toString(), fingerprint: cert.fingerprint256 });
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

interface AgentReply {
  status: number;
  body: unknown;
}

/**
 * The connections kept open to each probe agent. A new one for each reading was
 * a TLS handshake a reading on both machines, to say nothing the last one had
 * not. The pin is the pool's, not each request's: Node keeps no connection made
 * by a request with a checkServerIdentity of its own. A pool only ever connects
 * to the certificate it was made for, and is let go when that changes. Sessions
 * are not resumed, since a resumed handshake is shown no certificate to check.
 */
const connections = new Map<string, { to: string; pool: https.Agent }>();

function connectionsTo(agent: ProbeAgentConnection): https.Agent {
  const to = `${agent.address}|${agent.port}|${agent.fingerprint}`;
  const kept = connections.get(agent.id);
  if (kept?.to === to) return kept.pool;
  kept?.pool.destroy();
  const pinned = agent.fingerprint;
  const pool = new https.Agent({
    keepAlive: true,
    maxFreeSockets: AGENT_CONNECTIONS_KEPT,
    timeout: CONNECTION_KEPT_MS,
    maxCachedSessions: 0,
    servername: sniFor(agent.address),
    ca: agent.certPem!,
    // The chain is checked against the pinned certificate above; this checks
    // it is that very certificate, whatever name it was reached by.
    checkServerIdentity: (_host, cert) =>
      cert.fingerprint256 === pinned
        ? undefined
        : Object.assign(new Error('The certificate is not the pinned one'), { code: 'CERT_PINNED_MISMATCH' }),
    minVersion: 'TLSv1.3',
  });
  connections.set(agent.id, { to, pool });
  return pool;
}

/** One request to a paired agent, over its pinned certificate. */
function callProbeAgent(
  agent: ProbeAgentConnection,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  timeoutMs: number
): Promise<AgentReply> {
  if (!agent.certPem || !agent.fingerprint) {
    return Promise.reject(new ProbeAgentUnavailableError(agent.name, 'Not connected yet', 'unpaired'));
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);

  const attempt = (): Promise<AgentReply> => new Promise((resolve, reject) => {
    const request = https.request({
      host: agent.address,
      port: agent.port,
      method,
      path,
      agent: connectionsTo(agent),
      headers: {
        Authorization: `Bearer ${agent.token}`,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    });

    const connectTimer = setTimeout(
      () => request.destroy(Object.assign(new Error('No answer in time'), { code: 'ETIMEDOUT' })),
      CONNECT_TIMEOUT_MS
    );
    const overallTimer = setTimeout(
      () => request.destroy(Object.assign(new Error(`No reply within ${timeoutMs / 1000}s`), { code: 'ETIMEDOUT' })),
      timeoutMs
    );
    request.on('socket', socket => {
      if (request.reusedSocket) clearTimeout(connectTimer);
      else socket.once('secureConnect', () => clearTimeout(connectTimer));
    });

    request.on('response', response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(connectTimer);
        clearTimeout(overallTimer);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // A reply that is not JSON is judged by its status alone.
        }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
      response.on('error', reject);
    });
    request.on('error', error => {
      clearTimeout(connectTimer);
      clearTimeout(overallTimer);
      // A kept connection that had closed at the agent's end, as it may at any
      // moment: that says nothing about the agent, and a new one will.
      if (request.reusedSocket && (error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve(attempt());
      else reject(error);
    });
    request.end(payload);
  });
  return attempt();
}

/**
 * Turn whatever went wrong talking to an agent into what it means. A
 * certificate refused is looked at once more, from the handshake alone, so the
 * new fingerprint can be shown beside the old.
 */
async function unavailable(agent: ProbeAgentConnection, error: unknown): Promise<ProbeAgentUnavailableError> {
  if (error instanceof ProbeAgentUnavailableError) return error;
  const code = (error as NodeJS.ErrnoException)?.code ?? '';
  if (CERTIFICATE_ERRORS.has(code)) {
    const offered = await presentedCertificate(agent.address, agent.port).catch(() => null);
    return new ProbeAgentUnavailableError(
      agent.name,
      'It presented a different certificate from the one trusted for it',
      'cert-changed',
      offered?.fingerprint
    );
  }
  return new ProbeAgentUnavailableError(agent.name, plainReason(error), 'offline');
}

/** What a reply's status says about the agent, when it is not a success. */
function refusal(agent: ProbeAgentConnection, reply: AgentReply): ProbeAgentUnavailableError {
  const said = (reply.body as { error?: string } | null)?.error;
  if (reply.status === 401 || reply.status === 429) {
    return new ProbeAgentUnavailableError(agent.name, 'It refused the token. Give it the current token, or make a new one.', 'token-rejected');
  }
  if (reply.status === 503) return new ProbeAgentUnavailableError(agent.name, said ?? 'It is busy');
  return new ProbeAgentUnavailableError(agent.name, said ?? `It answered ${reply.status}`);
}

async function call(
  agent: ProbeAgentConnection,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  timeoutMs: number
): Promise<unknown> {
  let reply: AgentReply;
  try {
    reply = await callProbeAgent(agent, method, path, body, timeoutMs);
  } catch (error) {
    throw await unavailable(agent, error);
  }
  if (reply.status !== 200) throw refusal(agent, reply);
  return reply.body;
}

/** Record what a failure says about the agent, then pass it on. */
async function noting<T>(agent: ProbeAgentConnection, work: () => Promise<T>): Promise<T> {
  try {
    const result = await work();
    if (agent.state !== 'online') await setProbeAgentState(agent.id, 'online');
    return result;
  } catch (error) {
    const failure = await unavailable(agent, error);
    if (failure.state) {
      await setProbeAgentState(agent.id, failure.state, { error: failure.message, offeredFingerprint: failure.offeredFingerprint });
    }
    throw failure;
  }
}

async function info(agent: ProbeAgentConnection): Promise<ProbeAgentInfo> {
  const body = await call(agent, 'GET', '/v1/info', undefined, INFO_TIMEOUT_MS);
  if (!isProbeAgentInfo(body)) throw new ProbeAgentUnavailableError(agent.name, 'It did not answer as a ClearPing probe agent', 'offline');
  if (body.protocol !== PROBE_AGENT_PROTOCOL) {
    throw new ProbeAgentUnavailableError(
      agent.name,
      body.protocol < PROBE_AGENT_PROTOCOL
        ? `It is version ${body.version}, too old for this dashboard. Update the probe agent.`
        : `It is version ${body.version}, newer than this dashboard understands. Update ClearPing.`,
      'outdated'
    );
  }
  return body;
}

/** Ask a paired agent how it is, and note the answer. For the health checks. */
export async function checkProbeAgent(agent: ProbeAgentConnection): Promise<ProbeAgentState> {
  try {
    const reported = await info(agent);
    return await setProbeAgentState(agent.id, 'online', { info: reported });
  } catch (error) {
    const failure = await unavailable(agent, error);
    const state = failure.state ?? agent.state;
    // The state it is kept in: still online while it is within its time to answer.
    return await setProbeAgentState(agent.id, state, { error: failure.message, offeredFingerprint: failure.offeredFingerprint });
  }
}

export type ConnectOutcome =
  | { ok: true; fingerprint: string; info: ProbeAgentInfo; pinned: boolean }
  | { ok: false; state: ProbeAgentState; error: string; offeredFingerprint?: string };

/**
 * Connect to a probe agent: pair with it the first time, test it after that.
 *
 * The first time, its certificate is pinned before the token is sent, and
 * unpinned again if it then refuses the token: that was not the agent the
 * token is for. With `trustOffered`, a changed certificate is accepted, but
 * only the very one that was shown for trusting.
 */
export async function connectProbeAgent(id: string, options: { trustOffered?: boolean } = {}): Promise<ConnectOutcome | null> {
  const agent = await getProbeAgentConnection(id);
  if (!agent) return null;

  let presented: { pem: string; fingerprint: string };
  try {
    presented = await presentedCertificate(agent.address, agent.port);
  } catch (error) {
    const reason = plainReason(error);
    if (agent.fingerprint) await setProbeAgentState(id, 'offline', { error: reason });
    return { ok: false, state: 'offline', error: reason };
  }

  let pinned = false;
  if (agent.fingerprint !== presented.fingerprint) {
    const accept = !agent.fingerprint || (options.trustOffered && presented.fingerprint === agent.offeredFingerprint);
    if (!accept) {
      const error = options.trustOffered
        ? 'It now presents yet another certificate. Check the fingerprint in its log, then try again.'
        : 'It presented a different certificate from the one trusted for it';
      await setProbeAgentState(id, 'cert-changed', { error, offeredFingerprint: presented.fingerprint });
      return { ok: false, state: 'cert-changed', error, offeredFingerprint: presented.fingerprint };
    }
    await pinProbeAgentCertificate(id, presented.pem, presented.fingerprint);
    pinned = true;
  }

  const current = { ...agent, certPem: presented.pem, fingerprint: presented.fingerprint };
  try {
    const reported = await info(current);
    await setProbeAgentState(id, 'online', { info: reported });
    return { ok: true, fingerprint: presented.fingerprint, info: reported, pinned };
  } catch (error) {
    const failure = await unavailable(current, error);
    const state = failure.state ?? 'offline';
    // Never trusted before, and not the agent the token is for.
    if (pinned && !agent.fingerprint) await unpinProbeAgentCertificate(id);
    await setProbeAgentState(id, state, { error: failure.message });
    return { ok: false, state, error: failure.message };
  }
}

/** Why a probe agent known not to be working is not asked, in words to show. */
function notWorking(state: ProbeAgentState): string {
  switch (state) {
    case 'unpaired':
      return 'it has not been connected to yet';
    case 'offline':
      return 'it could not be reached at its last check, so nothing was taken';
    case 'cert-changed':
      return 'it presents a certificate that is not trusted for it';
    case 'token-rejected':
      return 'it refuses this dashboard\'s token';
    case 'outdated':
      return 'it and this dashboard are different versions';
    default:
      return 'it is not working';
  }
}

/**
 * Take a round of readings for a target: here, or from its probe agent.
 *
 * The one place that decides where a target is probed from, so the scheduler
 * and "Probe now" can never disagree. A remote round is stamped with this
 * machine's clock, so an agent's clock being out cannot move it on the chart.
 * An agent known to be down is not tried: the health checks notice when it is
 * back, and until then each target's round is skipped at once.
 */
export async function runProbes(
  target: ProbeTarget & Pick<Target, 'probeAgentId' | 'probes'>,
  probe: ProbeId = primaryProbeOf(target)
): Promise<ProbeResult[]> {
  // Without the resolvers this probe does not ask, and with no word of them to a probe agent.
  const probeConfig = configForProbe(target.probeConfig, probe);
  if (probe === LOCAL_PROBE) return (await executeProbes({ ...target, probeConfig })).map(result => ({ ...result, probe }));

  const agent = await getProbeAgentConnection(probe);
  if (!agent) throw new ProbeAgentUnavailableError('(removed)', 'Its probe agent no longer exists');
  if (agent.state !== 'online') throw new ProbeAgentUnavailableError(agent.name, notWorking(agent.state));

  const startedAt = new Date();
  const results = await noting(agent, async () => {
    const body = await call(
      agent,
      'POST',
      '/v1/probe',
      { target: { id: target.id, host: target.host, probeType: target.probeType, ipVersion: target.ipVersion, probeConfig } },
      PROBE_TIMEOUT_MS
    );
    const revived = reviveResults(body);
    if (!revived) throw new ProbeAgentUnavailableError(agent.name, 'It sent back something that is not a reading');
    return revived;
  });
  return results.map(result => ({ ...result, targetId: target.id, timestamp: startedAt, probe }));
}

/**
 * Trace the route to a target over one family: from here, or from a probe
 * agent. From the target's primary probe unless told which.
 */
export async function runTrace(
  target: Pick<Target, 'id' | 'host' | 'probeAgentId' | 'probes'>,
  trigger: Traceroute['trigger'],
  ipVersion: ProbeIpVersion,
  probe: ProbeId = primaryProbeOf(target)
): Promise<Traceroute> {
  if (probe === LOCAL_PROBE) return { ...(await runTraceroute(target, trigger, ipVersion)), probe };

  const agent = await getProbeAgentConnection(probe);
  if (!agent) throw new ProbeAgentUnavailableError('(removed)', 'Its probe agent no longer exists');
  if (agent.state !== 'online') throw new ProbeAgentUnavailableError(agent.name, notWorking(agent.state));

  const startedAt = new Date();
  const trace = await noting(agent, async () => {
    const body = await call(agent, 'POST', '/v1/traceroute', { target: { id: target.id, host: target.host }, ipVersion }, TRACE_TIMEOUT_MS);
    const revived = reviveTrace(body);
    if (!revived) throw new ProbeAgentUnavailableError(agent.name, 'It sent back something that is not a trace');
    return revived;
  });
  return { ...trace, targetId: target.id, trigger, timestamp: startedAt, probe };
}

/**
 * How an agent's address is reached. A name is judged by what it resolves to
 * from here: a public-looking name can point into a tailnet.
 */
export async function resolveExposure(address: string): Promise<ProbeAgentExposure> {
  const written = exposureOfAddress(address);
  if (written !== 'public' || isIP(address) || isTailnetAddress(address)) return written;
  try {
    const addresses = (await lookup(address, { all: true })).map(entry => entry.address);
    if (addresses.length === 0) return 'public';
    if (addresses.every(isTailnetAddress)) return 'tailnet';
    if (addresses.every(entry => isTailnetAddress(entry) || isPrivateAddress(entry))) return 'private';
  } catch {
    // A name that does not resolve yet is judged as written.
  }
  return 'public';
}
