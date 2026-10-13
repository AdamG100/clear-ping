import { NextResponse } from 'next/server';

/**
 * GET /api/mcp/info - What someone setting up an assistant needs to be told
 *
 * Whether a token has to be sent, and so whether an assistant that sends it
 * can change things as well as read them. Never the token: the dialog that
 * shows how to connect uses this to write the command with a place for one.
 */
export function GET() {
  const tokenRequired = !!process.env.CLEARPING_MCP_TOKEN?.trim();
  return NextResponse.json({
    tokenRequired,
    // The two go together: changing anything takes the token.
    writes: tokenRequired,
    // Set by someone who has encryption of their own in front, such as a VPN.
    plainHttpAllowed: process.env.CLEARPING_MCP_ALLOW_HTTP === '1',
  });
}
