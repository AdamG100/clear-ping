import { NextResponse } from 'next/server';
import { getUpgradeHistory } from '@/lib/db/database';
import { initializeServer } from '@/lib/init';
import { SCHEMA_VERSION } from '@/lib/db/migrations';

/**
 * GET /api/upgrade/history - The upgrades this database has had
 *
 * Newest first: when, from which schema version to which, how long it took and
 * what was done. For Settings, Maintenance.
 */
export async function GET() {
  try {
    await initializeServer();
    return NextResponse.json({ schemaVersion: SCHEMA_VERSION, upgrades: await getUpgradeHistory() });
  } catch (error) {
    console.error('Error reading the upgrade history:', error);
    return NextResponse.json({ error: 'Failed to read the upgrade history' }, { status: 500 });
  }
}
