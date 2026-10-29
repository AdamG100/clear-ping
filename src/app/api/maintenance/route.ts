import { NextRequest, NextResponse } from 'next/server';
import { getAlerts } from '@/lib/alerts/store';
import { initializeServer } from '@/lib/init';
import {
  getMaintenanceHistory,
  getMaintenanceSettings,
  MAINTENANCE_STEPS,
  maintenanceProgress,
  nextScheduledRun,
  parseMaintenanceSettings,
  runMaintenance,
  saveMaintenanceSettings,
} from '@/lib/db/maintenance';
import { actorFor } from '@/lib/security/access';
import { requireAdmin } from '@/lib/security/http';
import { recordActivity } from '@/lib/security/store';

/**
 * Maintenance: clearing out what no longer belongs, on a schedule or on
 * request. Admins only: it deletes, and it can send to the destinations of an
 * alert.
 */

/** The page's whole picture: settings, the alerts a report can go through, past runs and any run now. */
async function overview() {
  const [settings, history, next, alerts] = await Promise.all([
    getMaintenanceSettings(),
    getMaintenanceHistory(),
    nextScheduledRun(),
    getAlerts(),
  ]);
  return {
    settings,
    history,
    nextRunAt: next,
    running: maintenanceProgress(),
    steps: MAINTENANCE_STEPS,
    // Only what is needed to choose one. Where it sends to stays with the alert.
    alerts: alerts.map(alert => ({
      id: alert.id,
      name: alert.name || `${alert.metric} alert`,
      destinations: alert.notifyUrls.length,
    })),
    // The hour is by the server's clock, which is not always the browser's.
    serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** GET /api/maintenance - Settings, the last runs, and whether one is under way */
export async function GET(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  try {
    await initializeServer();
    return NextResponse.json(await overview());
  } catch (error) {
    console.error('Error reading maintenance:', error);
    return NextResponse.json({ error: 'Failed to read maintenance' }, { status: 500 });
  }
}

/**
 * PUT /api/maintenance - Change the schedule
 * Body: { enabled, frequency, hour, alertId, notify, reclaimSpace }
 */
export async function PUT(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  try {
    await initializeServer();
    const parsed = parseMaintenanceSettings(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    if (parsed.settings.alertId && !(await getAlerts()).some(alert => alert.id === parsed.settings.alertId)) {
      return NextResponse.json({ error: 'That alert does not exist' }, { status: 400 });
    }

    await saveMaintenanceSettings(parsed.settings);
    const { actor, via } = await actorFor(request);
    await recordActivity(
      actor,
      via,
      'maintenance.settings',
      parsed.settings.enabled ? `${parsed.settings.frequency} at ${String(parsed.settings.hour).padStart(2, '0')}:00` : 'schedule off'
    );
    return NextResponse.json(await overview());
  } catch (error) {
    console.error('Error saving maintenance settings:', error);
    return NextResponse.json({ error: 'Failed to save the settings' }, { status: 500 });
  }
}

/**
 * POST /api/maintenance - Run it now
 *
 * Answers at once, 202, and goes on in the background: checking a large
 * database takes a while. The page asks again for how far it has got.
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin(request);
  if (user instanceof NextResponse) return user;

  try {
    await initializeServer();
    if (maintenanceProgress()) {
      return NextResponse.json({ error: 'Maintenance is already running' }, { status: 409 });
    }

    const { actor, via } = await actorFor(request);
    await recordActivity(actor, via, 'maintenance.run');
    void runMaintenance('manual').catch(error => console.error('[Maintenance] Manual run failed:', error));
    const startedAt = maintenanceProgress()?.startedAt ?? Date.now();
    return NextResponse.json({ started: true, startedAt }, { status: 202 });
  } catch (error) {
    console.error('Error starting maintenance:', error);
    return NextResponse.json({ error: 'Failed to start maintenance' }, { status: 500 });
  }
}
