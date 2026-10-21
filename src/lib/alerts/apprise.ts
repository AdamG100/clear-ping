import { spawn } from 'child_process';
import type { AlertNotification } from './delivery';

/**
 * Sending a notification, which is Apprise's job.
 *
 * Apprise (https://github.com/caronc/apprise) knows how to post to a hundred
 * or so services, each named by a URL: `discord://…`, `mailto://…`,
 * `tgram://…`. It is a Python program, and is run here the way `ping` and
 * `traceroute` are: once for each notification, and read for what it says.
 * The Docker image has it installed. Anywhere else it is `pip install
 * apprise`, with CLEARPING_APPRISE_BIN naming the program if it is not on the
 * PATH.
 */

export interface DeliveryResult {
  ok: boolean;
  /** Why it was not delivered, in words fit to show the person who set it up. */
  detail?: string;
}

/**
 * How long Apprise gets. Most of a second goes on starting Python, and a mail
 * server can take several more; past this something is stuck, and the probe
 * that is waiting on the notification should not be.
 */
const TIMEOUT_MS = 30_000;

const NOT_INSTALLED =
  'Apprise is not installed where ClearPing can run it. Install it with "pip install apprise", ' +
  'or set CLEARPING_APPRISE_BIN to where the apprise program is.';

interface Run {
  /** The exit status; null if it never ran or was stopped. */
  code: number | null;
  /** Everything it printed. Its log goes to either stream, depending on what it was asked to do. */
  output: string;
  missing: boolean;
  timedOut: boolean;
}

/**
 * What Apprise and its plugins may see of ClearPing's environment: where to
 * find programs and files, and how to reach the network. Not the rest, which
 * holds BETTER_AUTH_SECRET, CLEARPING_MCP_TOKEN and the like.
 */
const APPRISE_ENV = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'USERPROFILE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
];

export function appriseEnvironment(source: NodeJS.ProcessEnv, urls: string): NodeJS.ProcessEnv {
  const kept: Record<string, string> = { APPRISE_URLS: urls };
  for (const name of APPRISE_ENV) { const value = source[name]; if (value !== undefined) kept[name] = value; }
  return kept as unknown as NodeJS.ProcessEnv;
}

function runApprise(args: string[], urls: string[]): Promise<Run> {
  return new Promise(resolve => {
    let output = '';
    let timedOut = false;

    const child = spawn(process.env.CLEARPING_APPRISE_BIN || 'apprise', args, {
      // The URLs go in the environment rather than on the command line. They
      // are as good as passwords, and a command line can be read by anything
      // else on the machine for as long as the program runs.
      env: appriseEnvironment(process.env, urls.join(' ')),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Not waiting for it to close: anything it started that still holds its
      // output open would keep the probe waiting on it after all.
      finish(null);
    }, TIMEOUT_MS);

    const finish = (code: number | null, missing = false) => {
      clearTimeout(timer);
      resolve({ code, output, missing, timedOut });
    };

    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    child.on('error', (error: NodeJS.ErrnoException) => finish(null, error.code === 'ENOENT'));
    child.on('close', code => finish(code));
  });
}

interface LogLine {
  level: string;
  message: string;
}

const LOG_LINE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d+ - (\w+) - (.+)$/;

/**
 * What Apprise logged, without the timestamps.
 *
 * It explains a failure in its log and nowhere else: the exit status says only
 * that something failed. It writes a URL into its log with the secret parts
 * masked, so what comes out of here can be shown and logged in turn.
 */
export function readAppriseLog(output: string): LogLine[] {
  return output
    .split(/\r?\n/)
    .map(line => LOG_LINE.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, level, message]) => ({ level, message }));
}

/** Everything in the log that is about something going wrong, as one sentence or several. */
function complaints(log: LogLine[]): string {
  return log
    .filter(line => line.level === 'WARNING' || line.level === 'ERROR' || line.level === 'CRITICAL')
    .map(line => line.message)
    .join(' ')
    .slice(0, 500);
}

// Apprise's exit statuses, where they say more than "it failed".
const STATUS_PARTIAL = 4;
const STATUS_TIMEOUT = 5;

/**
 * Whether a run did all it was asked, going by its status and its log.
 *
 * Both, because a URL Apprise cannot make sense of is logged as an error and
 * then left out: with another URL beside it that works, the run still ends
 * with a status of 0.
 */
function outcome(run: Run, failed: { all: string; some: string }): DeliveryResult {
  if (run.missing) return { ok: false, detail: NOT_INSTALLED };
  if (run.timedOut || run.code === STATUS_TIMEOUT) {
    return { ok: false, detail: `Apprise did not finish within ${TIMEOUT_MS / 1000} seconds` };
  }

  const log = readAppriseLog(run.output);
  const refused = log.some(line => line.level === 'ERROR' || line.level === 'CRITICAL');
  if (run.code === 0 && !refused) return { ok: true };

  const what = run.code === 0 || run.code === STATUS_PARTIAL ? failed.some : failed.all;
  const why = complaints(log) || (run.code === null ? 'it could not be run' : `it exited with status ${run.code}`);
  return { ok: false, detail: `${what}: ${why}` };
}

/** Send one notification to every URL, and say how that went. */
export async function sendNotification(urls: string[], notification: AlertNotification): Promise<DeliveryResult> {
  const run = await runApprise(
    [
      // One level of verbosity is what makes it log why a service refused.
      '-v',
      `--title=${notification.title}`,
      `--body=${notification.body}`,
      `--notification-type=${notification.type}`,
      '--input-format=html',
    ],
    urls
  );
  return outcome(run, {
    all: 'Apprise could not deliver it',
    some: 'Apprise delivered it to some of the notification URLs but not all',
  });
}

/**
 * Ask Apprise whether it can make sense of these URLs, without sending
 * anything: that the service exists, and that the URL has what it needs.
 *
 * Where Apprise is not installed there is nothing to ask, and the URLs are
 * let through. The alert can still be made, and "Send test" says what is
 * missing.
 */
export async function checkNotifyUrls(urls: string[]): Promise<DeliveryResult> {
  if (urls.length === 0) return { ok: true };

  const run = await runApprise(['--dry-run', '-v'], urls);
  if (run.missing) return { ok: true };
  return outcome(run, {
    all: 'Apprise cannot use the notification URL',
    some: 'Apprise cannot use one of the notification URLs',
  });
}
