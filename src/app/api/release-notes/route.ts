import { NextResponse } from 'next/server';
import { releaseNotes } from '@/lib/release-notes';

/**
 * GET /api/release-notes - What changed in each version, newest first
 *
 * The notes this build carries, up to its own version. See src/lib/release-notes.ts.
 */
export async function GET() {
  return NextResponse.json({ releases: await releaseNotes() });
}
