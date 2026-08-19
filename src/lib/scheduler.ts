/**
 * Probe Scheduler Service
 * 
 * Automatically probes targets at their configured intervals, similar to Smokeping.
 * Each target is probed at its set interval (e.g., every 5 minutes), and measurements
 * are captured and stored for visualization on graphs.
 */

import { getAllTargets, storeMeasurement, getDatabase, saveDatabaseToDisk, cleanOldMeasurements } from './database';
import { executePing, pingMultipleTargets } from './ping';
import { executeDnsProbe } from './dns';
import type { ProbeResult } from '@/types/probe';
import { randomUUID } from 'crypto';
import { dispatchAlert, ensureAlertSchema, evaluateAlerts } from './alerts';

interface ScheduledTarget {
  id: string;
  name: string;
  host: string;
  probeType: 'ping' | 'dns';
  interval: number; // seconds
  lastProbeTime: number; // timestamp
  isProbing: boolean;
}

class ProbeScheduler {
  private scheduledTargets: Map<string, ScheduledTarget> = new Map();
  private intervalId: NodeJS.Timeout | null = null;
  private reloadIntervalId: NodeJS.Timeout | null = null;
  private retentionIntervalId: NodeJS.Timeout | null = null;
  private retentionDays: number = Number(process.env.CLEARPING_RETENTION_DAYS ?? 90);
  private checkIntervalMs: number = 10000; // Check every 10 seconds
  private isRunning: boolean = false;
  private tickInFlight: boolean = false;

  /**
   * Start the scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[Scheduler] Already running');
      return;
    }

    console.log('[Scheduler] Starting probe scheduler...');
    this.isRunning = true;

    await ensureAlertSchema();

    // Load all active targets
    await this.loadTargets();

    // Start the periodic check. Ticks are serialised: a probe run can outlast
    // the 10s check interval, and overlapping runs would double-probe.
    this.intervalId = setInterval(() => {
      if (this.tickInFlight) return;
      this.tickInFlight = true;
      this.checkAndProbeTargets()
        .catch(error => console.error('[Scheduler] Probe tick failed:', error))
        .finally(() => { this.tickInFlight = false; });
    }, this.checkIntervalMs);

    // Also reload targets periodically (every 5 minutes) to pick up new targets
    this.reloadIntervalId = setInterval(() => {
      this.loadTargets();
    }, 5 * 60 * 1000);

    // Retention. Without this the measurements table grows without bound —
    // six targets on a five-minute interval is about 630,000 rows a year.
    void this.runRetention();
    this.retentionIntervalId = setInterval(() => {
      void this.runRetention();
    }, 6 * 60 * 60 * 1000);

    console.log('[Scheduler] Probe scheduler started successfully');
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.reloadIntervalId) {
      clearInterval(this.reloadIntervalId);
      this.reloadIntervalId = null;
    }
    if (this.retentionIntervalId) {
      clearInterval(this.retentionIntervalId);
      this.retentionIntervalId = null;
    }
    this.isRunning = false;
    console.log('[Scheduler] Probe scheduler stopped');
  }

  /**
   * Load all active targets from database
   */
  private async loadTargets(): Promise<void> {
    try {
      const targets = await getAllTargets();
      const activeTargets = targets.filter(t => t.status === 'active');

      // Read every last_probe_at in one query rather than one per target.
      const db = await getDatabase();
      const lastProbeTimes = await new Promise<Map<string, number>>((resolve, reject) => {
        db.all('SELECT id, last_probe_at FROM targets', [], (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          const map = new Map<string, number>();
          for (const row of (rows ?? []) as { id: string; last_probe_at: number | null }[]) {
            map.set(row.id, row.last_probe_at ?? 0);
          }
          resolve(map);
        });
      });

      for (const target of activeTargets) {
        const existing = this.scheduledTargets.get(target.id);

        this.scheduledTargets.set(target.id, {
          id: target.id,
          name: target.name,
          host: target.host,
          probeType: target.probeType,
          interval: target.interval,
          // A probe in flight has already claimed its slot; restoring the
          // stored timestamp underneath it would schedule a duplicate run.
          lastProbeTime: existing?.isProbing
            ? existing.lastProbeTime
            : lastProbeTimes.get(target.id) ?? 0,
          isProbing: existing?.isProbing ?? false,
        });
      }

      // Remove targets that no longer exist or are inactive
      const activeIds = new Set(activeTargets.map(t => t.id));
      for (const [id] of this.scheduledTargets) {
        if (!activeIds.has(id)) {
          this.scheduledTargets.delete(id);
        }
      }

      console.log(`[Scheduler] Loaded ${this.scheduledTargets.size} active targets`);
    } catch (error) {
      console.error('[Scheduler] Error loading targets:', error);
    }
  }

  /**
   * Check all targets and probe those that need it
   */
  private async checkAndProbeTargets(): Promise<void> {
    const now = Date.now();
    const targetsToProbe: ScheduledTarget[] = [];

    // Collect all targets that need probing
    for (const target of this.scheduledTargets.values()) {
      // Skip if already probing
      if (target.isProbing) {
        continue;
      }

      // Calculate time since last probe
      const timeSinceLastProbe = now - target.lastProbeTime;
      const intervalMs = target.interval * 1000;

      // If it's time to probe (or never probed), add to list
      if (timeSinceLastProbe >= intervalMs) {
        targetsToProbe.push(target);
      }
    }

    if (targetsToProbe.length === 0) return;

    const pingTargets = targetsToProbe.filter(t => t.probeType === 'ping');
    const otherTargets = targetsToProbe.filter(t => t.probeType !== 'ping');

    // Batch ping targets together; a single one still has to be probed, so it
    // goes through the same path rather than being dropped from both branches.
    if (pingTargets.length > 0) {
      await this.probeTargetsParallel(pingTargets);
    }

    for (const target of otherTargets) {
      await this.probeTarget(target.id);
    }
  }

  /**
   * Probe multiple ping targets in parallel
   */
  private async probeTargetsParallel(targets: ScheduledTarget[]): Promise<void> {
    // Mark all targets as probing
    targets.forEach(target => {
      target.isProbing = true;
      target.lastProbeTime = Date.now();
    });

    try {
      const targetData = targets.map(target => ({
        id: target.id,
        host: target.host,
      }));

      const results = await pingMultipleTargets(targetData);

      // Store results independently: one target failing to store must not
      // discard the measurements of every target after it in the batch.
      for (const result of results) {
        const target = targets.find(t => t.id === result.targetId);
        if (!target) continue;

        try {
          await this.recordResult(target, result);
        } catch (error) {
          console.error(`[Scheduler] Failed to record probe for ${target.name}:`, error);
        }
      }

      saveDatabaseToDisk();

    } catch (error) {
      console.error('[Scheduler] Error in parallel probing:', error);
    } finally {
      // Mark all targets as no longer probing
      targets.forEach(target => {
        target.isProbing = false;
      });
    }
  }

  /**
   * Persist a probe result and stamp the target's last-probe time.
   *
   * `last_probe_at` is written even when the probe failed. If it were only
   * written on success, `loadTargets()` would keep restoring a stale (or zero)
   * timestamp for an unreachable target and the scheduler would re-probe it on
   * every 10-second tick instead of at its configured interval.
   */
  private async recordResult(
    target: ScheduledTarget,
    result: ProbeResult
  ): Promise<void> {
    const db = await getDatabase();

    try {
      await storeMeasurement({
        id: randomUUID(),
        targetId: result.targetId,
        timestamp: result.timestamp,
        latency: result.latency,
        minLatency: result.minLatency ?? null,
        maxLatency: result.maxLatency ?? null,
        p10Latency: result.p10Latency ?? null,
        p25Latency: result.p25Latency ?? null,
        p50Latency: result.p50Latency ?? null,
        p75Latency: result.p75Latency ?? null,
        p90Latency: result.p90Latency ?? null,
        // `??`, not `||`: a jitter of exactly 0 is a perfectly stable path, not
        // a missing reading, and 0% loss is not the same as "unknown".
        packetLoss: result.packetLoss ?? 0,
        jitter: result.jitter ?? null,
        success: result.success,
        errorMessage: result.errorMessage,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        db.run(
          'UPDATE targets SET updated_at = ?, last_probe_at = ? WHERE id = ?',
          [Date.now(), target.lastProbeTime, target.id],
          function (err) {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }

    console.log(
      `[Scheduler] Probe complete for ${target.name}: ` +
      `${result.success ? `${result.latency}ms` : 'FAILED'} ` +
      `(Loss: ${result.packetLoss ?? 0}%)`
    );

    await this.evaluateAndNotify(target, result);
  }

  /**
   * Run this target's alert rules against the probe result.
   *
   * Alerting must never be able to stop measurements being recorded, so this
   * runs after the measurement is stored and swallows its own failures.
   */
  private async evaluateAndNotify(
    target: ScheduledTarget,
    result: ProbeResult
  ): Promise<void> {
    try {
      const events = await evaluateAlerts(
        { id: target.id, name: target.name, host: target.host },
        result
      );

      for (const event of events) {
        console.log(
          `[Alerts] ${event.transition.toUpperCase()}: ${event.targetName} ` +
          `${event.metric}=${event.observed ?? 'n/a'} (threshold ${event.threshold})`
        );
        await dispatchAlert(event);
      }
    } catch (error) {
      console.error(`[Scheduler] Alert evaluation failed for ${target.name}:`, error);
    }
  }

  /**
   * Probe a single target
   */
  private async probeTarget(targetId: string): Promise<void> {
    const target = this.scheduledTargets.get(targetId);
    if (!target) return;

    // Mark as probing
    target.isProbing = true;
    target.lastProbeTime = Date.now();

    try {
      console.log(`[Scheduler] Probing ${target.name} (${target.host}) via ${target.probeType.toUpperCase()}`);

      let result;

      if (target.probeType === 'ping') {
        result = await executePing(target.id, target.host);
      } else if (target.probeType === 'dns') {
        result = await executeDnsProbe(target.id, target.host);
      } else {
        console.error(`[Scheduler] Invalid probe type for target ${target.id}`);
        return;
      }

      await this.recordResult(target, result);
      saveDatabaseToDisk();
    } catch (error) {
      console.error(`[Scheduler] Error probing target ${target.name}:`, error);
    } finally {
      target.isProbing = false;
    }
  }

  /**
   * Force probe a specific target immediately
   */
  async forceProbe(targetId: string): Promise<void> {
    const target = this.scheduledTargets.get(targetId);
    if (!target) {
      console.warn(`[Scheduler] Target ${targetId} not found in scheduler`);
      return;
    }

    await this.probeTarget(targetId);
  }

  /**
   * Reload targets from database (useful when targets are added/modified)
   */
  async reloadTargets(): Promise<void> {
    await this.loadTargets();
  }

  /**
   * Delete measurements past the retention window.
   *
   * Set CLEARPING_RETENTION_DAYS to 0 to keep everything.
   */
  private async runRetention(): Promise<void> {
    if (!Number.isFinite(this.retentionDays) || this.retentionDays <= 0) return;

    try {
      const removed = await cleanOldMeasurements(this.retentionDays);
      if (removed > 0) {
        console.log(`[Scheduler] Retention: removed ${removed} measurements older than ${this.retentionDays}d`);
      }
    } catch (error) {
      console.error('[Scheduler] Retention failed:', error);
    }
  }

  /**
   * Get scheduler status
   */
  getStatus(): {
    isRunning: boolean;
    targetCount: number;
    targets: Array<{
      id: string;
      name: string;
      host: string;
      interval: number;
      lastProbeTime: number;
      nextProbeIn: number;
      isProbing: boolean;
    }>;
  } {
    const now = Date.now();
    const targets = Array.from(this.scheduledTargets.values()).map(t => ({
      id: t.id,
      name: t.name,
      host: t.host,
      interval: t.interval,
      lastProbeTime: t.lastProbeTime,
      nextProbeIn: Math.max(0, (t.interval * 1000) - (now - t.lastProbeTime)),
      isProbing: t.isProbing,
    }));

    return {
      isRunning: this.isRunning,
      targetCount: this.scheduledTargets.size,
      targets,
    };
  }
}

/**
 * Singleton, held on `globalThis` rather than in module scope.
 *
 * A module-local `let` gives one scheduler *per module instance*, and there is
 * more than one: Next.js bundles route handlers into separate module graphs,
 * and dev-mode hot reload replaces the module while the previous instance's
 * timers keep firing. The result was several schedulers probing the same
 * targets in parallel — measured at roughly 56% duplicate probes, each pair
 * landing in the database within the same second.
 */
const SCHEDULER_KEY = Symbol.for('clearping.scheduler');

type SchedulerGlobal = typeof globalThis & {
  [SCHEDULER_KEY]?: ProbeScheduler;
};

/**
 * Get the global scheduler instance
 */
export function getScheduler(): ProbeScheduler {
  const store = globalThis as SchedulerGlobal;
  if (!store[SCHEDULER_KEY]) {
    store[SCHEDULER_KEY] = new ProbeScheduler();
  }
  return store[SCHEDULER_KEY];
}

/**
 * Start the global scheduler
 */
export async function startScheduler(): Promise<void> {
  const scheduler = getScheduler();
  await scheduler.start();
}

/**
 * Stop the global scheduler
 */
export function stopScheduler(): void {
  (globalThis as SchedulerGlobal)[SCHEDULER_KEY]?.stop();
}
