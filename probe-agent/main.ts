import { accessSync, constants } from 'node:fs';
import { hostname } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  PROBE_AGENT_DEFAULT_PORT,
  PROBE_AGENT_MIN_TOKEN_LENGTH,
  PROBE_AGENT_PROTOCOL,
} from '@/lib/probe-agents/protocol';
import { loadOrCreateCertificate } from './certificate';
import { createProbeAgentServer } from './server';

/**
 * ClearPing probe agent: takes readings from this machine for a ClearPing
 * dashboard somewhere else.
 *
 *   CLEARPING_PROBE_AGENT_TOKEN   required; the token the dashboard gave when
 *                                 the probe agent was added
 *   CLEARPING_PROBE_AGENT_LISTEN  address:port to listen on, 0.0.0.0:7380 by
 *                                 default. On a tailnet, give the machine's
 *                                 tailnet address to stay off every other
 *                                 interface.
 *   CLEARPING_PROBE_AGENT_DATA    where the certificate is kept
 *   CLEARPING_LOG_READINGS        1 logs every reading, not only those that
 *                                 lost something
 */

// Replaced with the release's number when the agent is built (scripts/build-probe-agent.mjs).
const VERSION = process.env.CLEARPING_PROBE_AGENT_VERSION || 'development';

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

function fail(message: string): never {
  console.error(`clearping-probe-agent: ${message}`);
  process.exit(1);
}

/**
 * The certificate kept in `directory`. A folder it may not write to is the
 * usual first-run trouble: a bind mount Docker made for root, while the
 * image runs as uid 1000. Said plainly, not as a stack trace.
 */
function certificateIn(directory: string): ReturnType<typeof loadOrCreateCertificate> {
  try {
    return loadOrCreateCertificate(directory, `clearping-probe-agent ${hostname()}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw error;
    const uid = process.getuid?.();
    fail(
      `cannot save its certificate in ${directory}: permission denied.` +
      (uid === undefined ? '' : ` It runs as uid ${uid}, so give that folder to it, for a Docker bind mount on the host:` +
        `\n\n  sudo chown -R ${uid}:${uid} ./data\n\nor use a named volume, as compose.probe-agent.example.yaml does.`)
    );
  }
}

/** Whether a program is on the PATH, without running it. */
function installed(program: string): boolean {
  const names = process.platform === 'win32' ? [`${program}.exe`, `${program}.com`] : [program];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      try {
        accessSync(join(directory, name), constants.X_OK);
        return true;
      } catch {
        // Not in this one.
      }
    }
  }
  return false;
}

function listenAddress(raw: string | undefined): { host: string; port: number } {
  const value = raw?.trim() || `0.0.0.0:${PROBE_AGENT_DEFAULT_PORT}`;
  // [v6]:port, v4:port, a bare port, or a bare address.
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(value);
  const plain = /^([^:]+):(\d+)$/.exec(value);
  const [host, port] = bracketed
    ? [bracketed[1], bracketed[2]]
    : plain
      ? [plain[1], plain[2]]
      : /^\d+$/.test(value)
        ? ['0.0.0.0', value]
        : [value, String(PROBE_AGENT_DEFAULT_PORT)];
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) fail(`Not a port: ${port}`);
  return { host, port: number };
}

function main(): void {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(`clearping-probe-agent ${VERSION} (protocol ${PROBE_AGENT_PROTOCOL})`);
    return;
  }

  const token = process.env.CLEARPING_PROBE_AGENT_TOKEN?.trim() ?? '';
  if (token.length < PROBE_AGENT_MIN_TOKEN_LENGTH) {
    fail(
      'CLEARPING_PROBE_AGENT_TOKEN is not set, or too short. Add the probe agent in ClearPing ' +
      '(Settings, Probe agents) and use the token it gives you.'
    );
  }

  const { host, port } = listenAddress(process.env.CLEARPING_PROBE_AGENT_LISTEN);
  const dataDirectory = process.env.CLEARPING_PROBE_AGENT_DATA?.trim() || join(process.cwd(), 'probe-agent-data');
  const certificate = certificateIn(dataDirectory);

  const tools = { ping: installed('ping'), traceroute: installed('traceroute'), arping: installed('arping') };
  if (!tools.ping) log('Warning: ping is not installed, so ping targets will fail. Install iputils-ping.');
  if (!tools.traceroute) log('Warning: traceroute is not installed, so traces will fail. Install traceroute.');
  // Only ARP monitors need it, so its absence is said but is not a warning.
  if (!tools.arping) log('arping is not installed, so ARP monitors cannot be measured from here. Install iputils-arping to use them.');

  const server = createProbeAgentServer({ token, key: certificate.key, cert: certificate.cert, version: VERSION, tools, log });

  server.on('error', error => fail(`Could not listen on ${host}:${port}: ${error.message}`));
  server.listen(port, host, () => {
    log(`ClearPing probe agent ${VERSION} listening on ${host.includes(':') ? `[${host}]` : host}:${port}`);
    log(certificate.created ? `Certificate made and saved in ${dataDirectory}` : `Certificate loaded from ${dataDirectory}`);
    log(`Certificate fingerprint (SHA-256): ${certificate.fingerprint}`);
    log('Compare it with the one ClearPing shows when it connects.');
  });

  const stop = () => {
    log('Stopping');
    server.close(() => process.exit(0));
    // Probes in flight are not waited for past this.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
