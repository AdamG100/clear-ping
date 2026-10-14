import { NextResponse } from 'next/server';
import { versionStatus } from '@/lib/version';

/**
 * GET /api/version - Which build this is, and whether a newer one is out
 *
 * The version, commit and build time this server was built with, and the same
 * for the newest published image, which is looked for at most once an hour.
 * See src/lib/version.ts.
 */
export async function GET() {
  return NextResponse.json(await versionStatus());
}
