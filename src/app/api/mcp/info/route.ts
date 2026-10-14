import { NextResponse } from 'next/server';
import { securityPolicy } from '@/lib/security/access';

/**
 * GET /api/mcp/info - What someone setting up an assistant needs to be told
 *
 * Whether a key has to be sent to connect at all. Never a key: the dialog that
 * shows how to connect uses this to write the command with a place for one.
 * A key that may change things is needed for an assistant to change anything,
 * whether or not one is needed to read.
 */
export async function GET() {
  const policy = await securityPolicy();
  return NextResponse.json({
    tokenRequired: policy.mcpKeyRequired,
    // Set by someone who has encryption of their own in front, such as a VPN.
    plainHttpAllowed: process.env.CLEARPING_MCP_ALLOW_HTTP === '1',
  });
}
