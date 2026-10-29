import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { handleMessage, JSON_RPC, MCP_PROTOCOL_VERSIONS, originAllowed, tokenTravelsSafely } from '@/lib/mcp/protocol';
import { clearPingMcp } from '@/lib/mcp/tools';
import { withAddressesHidden } from '@/lib/privacy/assistant';
import { privacyNow } from '@/lib/privacy/settings';
import { identify, presentedKey, securityPolicy } from '@/lib/security/access';
import { canChange } from '@/lib/security/roles';
import { ANONYMOUS, recordActivity } from '@/lib/security/store';

/**
 * POST /api/mcp - ClearPing as a Model Context Protocol server
 *
 * The address an AI assistant is given to read this installation: what is
 * monitored, how each target has done, and the evidence for a report to an
 * ISP.
 *
 * One JSON-RPC message in the body and one answer back as JSON. Nothing is
 * kept between requests and nothing is streamed, so there is no session and
 * no GET to listen on: the protocol lets a server say so, and this does.
 *
 * Each assistant is given a key of its own, made in the security settings,
 * that lets it read, or read and write targets. Without a key it may read,
 * unless keys are switched on for this address (they are whenever sign-in is
 * on), and never change anything. A key has to arrive over HTTPS or from the
 * server's own network, so that it is never sent in the clear across the
 * internet. What an assistant changes goes in the activity record under its
 * key's name. CLEARPING_MCP_TOKEN, from before keys were made in the
 * dashboard, still works as a key that can change things.
 */

const NOT_ALLOWED = { status: 405, headers: { Allow: 'POST' } } as const

function refuse(status: number, code: number, message: string, headers?: Record<string, string>) {
  return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status, headers });
}

export async function POST(request: NextRequest) {
  if (!originAllowed(request.headers.get('origin'), request.headers.get('host'))) {
    return refuse(403, JSON_RPC.invalidRequest, 'This page is not allowed to connect here');
  }

  // Before a key is so much as looked at: one that came in the clear across
  // the internet has been shown to everything on the way, right or wrong, and
  // the setup that sent it needs to be told so on its first try.
  if (presentedKey(request.headers)) {
    const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
    if (!tokenTravelsSafely(proto, request.headers.get('host'), process.env.CLEARPING_MCP_ALLOW_HTTP === '1')) {
      return refuse(
        403,
        JSON_RPC.invalidRequest,
        'This ClearPing will not take a key over plain HTTP from outside its own network. ' +
          'Connect to it over https://. (If it is already behind an HTTPS proxy, the proxy has to pass X-Forwarded-Proto on.) ' +
          'The key sent with this request travelled unencrypted: revoke it in the security settings and make a new one.'
      );
    }
  }

  const [policy, { actor, invalidKey }] = await Promise.all([securityPolicy(), identify(request)]);
  if (invalidKey) {
    return refuse(401, JSON_RPC.invalidRequest, 'That key is not valid, or has been revoked', { 'WWW-Authenticate': 'Bearer' });
  }
  if (!actor && policy.mcpKeyRequired) {
    return refuse(
      401,
      JSON_RPC.invalidRequest,
      'A key is needed to connect: make one in ClearPing\'s Settings → Keys and send it as "Authorization: Bearer <key>"',
      { 'WWW-Authenticate': 'Bearer' }
    );
  }

  const access = {
    // Someone signed in to the dashboard what their role allows; a key what it
    // was made for, no more than its maker may; and nobody at all, only read.
    writes: (actor?.kind === 'user' && canChange(actor.role)) || (actor?.kind === 'key' && actor.access === 'write'),
    onWrite: (tool: string, args: Record<string, unknown>, failed: boolean) =>
      recordActivity(actor ?? ANONYMOUS, 'mcp', `mcp.${tool}`, (failed ? 'Failed: ' : '') + JSON.stringify(args)),
  };

  // Sent by a client on everything after it has connected. One this does not
  // speak is refused, as the protocol asks; none at all is an older client.
  const version = request.headers.get('mcp-protocol-version');
  if (version && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return refuse(400, JSON_RPC.invalidRequest, `Unsupported protocol version: ${version}`);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse(400, JSON_RPC.parseError, 'The body is not JSON');
  }

  try {
    await initializeServer();

    // An older revision of the protocol lets several messages be sent as a list.
    const messages = Array.isArray(body) ? body : [body];
    const answers = [];
    for (const message of messages) {
      const answered = await handleMessage(clearPingMcp, message, access);
      if (answered) answers.push(answered);
    }

    // Nothing in it wanted an answer: taken, with nothing to say back.
    if (answers.length === 0) return new NextResponse(null, { status: 202 });
    const sent = privacyNow().hideFromAssistants ? await withAddressesHidden(answers) : answers;
    return NextResponse.json(Array.isArray(body) ? sent : sent[0]);
  } catch (error) {
    console.error('Error answering an MCP request:', error);
    return refuse(500, JSON_RPC.internalError, 'ClearPing could not answer');
  }
}

/** There is no stream to listen on: everything is answered where it is asked. */
export function GET() {
  return new NextResponse(null, NOT_ALLOWED);
}

/** Nor a session to end. */
export function DELETE() {
  return new NextResponse(null, NOT_ALLOWED);
}
