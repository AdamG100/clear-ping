import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { initializeServer } from '@/lib/init';
import { handleMessage, JSON_RPC, MCP_PROTOCOL_VERSIONS, originAllowed, tokenTravelsSafely } from '@/lib/mcp-protocol';
import { clearPingMcp } from '@/lib/mcp-tools';

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
 * With no CLEARPING_MCP_TOKEN set it is as open as the rest of the API and
 * can only read. With one set, every request has to carry it, a request that
 * does can also add and change targets, and it has to arrive over HTTPS or
 * from the server's own network, so that the token is never sent in the clear
 * across the internet.
 */

const NOT_ALLOWED = { status: 405, headers: { Allow: 'POST' } } as const

function refuse(status: number, code: number, message: string, headers?: Record<string, string>) {
  return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status, headers });
}

/** Whether a request carries the token, where one has been set. */
function hasToken(request: NextRequest, token: string): boolean {
  const given = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  // Compared in the same time whether or not it is right, and never by length alone.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!originAllowed(request.headers.get('origin'), request.headers.get('host'))) {
    return refuse(403, JSON_RPC.invalidRequest, 'This page is not allowed to connect here');
  }

  const token = process.env.CLEARPING_MCP_TOKEN?.trim();
  if (token) {
    // Before the token is so much as looked at: one that came in the clear
    // across the internet has been shown to everything on the way, right or
    // wrong, and the setup that sent it needs to be told so on its first try.
    const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
    if (!tokenTravelsSafely(proto, request.headers.get('host'), process.env.CLEARPING_MCP_ALLOW_HTTP === '1')) {
      return refuse(
        403,
        JSON_RPC.invalidRequest,
        'This ClearPing asks for a token, and will not take one over plain HTTP from outside its own network. ' +
          'Connect to it over https://. (If it is already behind an HTTPS proxy, the proxy has to pass X-Forwarded-Proto on.) ' +
          'If a token was sent with this request it travelled unencrypted: change CLEARPING_MCP_TOKEN.'
      );
    }
    if (!hasToken(request, token)) {
      return refuse(401, JSON_RPC.invalidRequest, 'A token is needed to connect: send it as "Authorization: Bearer <token>"', {
        'WWW-Authenticate': 'Bearer',
      });
    }
  }
  // Reading is as open as the app. Changing anything takes the token, so with
  // none set there is nothing here that can.
  const access = { writes: !!token };

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
    return NextResponse.json(Array.isArray(body) ? answers : answers[0]);
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
