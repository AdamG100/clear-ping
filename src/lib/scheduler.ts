/**
 * Probe Scheduler Service
 * 
 * Automatically probes targets at their configured intervals, similar to Smokeping.
 * Each target is probed at its set interval (e.g., every 5 minutes), and measurements
 * are captured and stored for visualization on graphs.
 */

import { getAllTargets, storeMeasurement, getDatabase, saveDatabaseToDisk, cleanOldMeasurements } from './db/database';
import { checkProbeAgent, ProbeAgentUnavailableError, runProbes } from './probe-agents/client';
import { cleanOldProbeAgentOutages, getProbeAgentConnection, pairedProbeAgentConnections } from './probe-agents/store';
import { measurementFrom, worstOf } from './probes/result';
import type { IpVersion, ProbeConfig, ProbeResult, ProbeType } from '@/types/probe';
import { randomUUID } from 'crypto';
import { asksForTrace, dispatchAlert, evaluateAlerts, shouldTraceOnAlert } from './alerts/store';
import { cleanOldTraceroutes, ensureTracerouteSchema, lastAlertTraceAt, traceAndStore } from './traceroute/store';

/**
 * Targets probed at once, per kind. Bounded so a long target list cannot
 * spawn hundreds of `ping` processes together, which would distort the very
 * latencies being measured.
 */
const PROBE_CONCURRENCY = 8;

/**
 * Targets probed at once through each probe agent. The waiting here is on the
 * network, not on this machine, but an agent on a small VPS should not be
 * handed every target at once either.
 */
const AGENT_CONCURRENCY = 4;

/** How often each probe agent is asked how it is, whether or not it has targets due. */
const AGENT_CHECK_INTERVAL_MS = 60_000;

interface ScheduledTarget {
  id: string;
  name: string;
  host: string;
  /** Only so an alert can say where the target lives. */
  group?: string;
  probeType: ProbeType;
  ipVersion: IpVersion;
  probeConfig?: ProbeConfig;
  /** Probed from this probe agent, or from here when null. */
  probeAgentId: string | null;
  interval: number; // seconds
  lastProbeTime: number; // timestamp
  isProbing: boolean;
}

class ProbeScheduler {
  private scheduledTargets: Map<string, ScheduledTarget> = new Map();
  private intervalId: NodeJS.Timeout | null = null;
  private reloadIntervalId: NodeJS.Timeout | null = null;
  private retentionIntervalId: NodeJS.Timeout | null = null;
  private agentCheckIntervalId: NodeJS.Timeout | null = null;
  private agentCheckInFlight: boolean = false;
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

    await ensureTracerouteSchema();

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

    // Probe agents. A round is only sent to an agent that answered last time,
    // so this is what notices one has gone, and what notices it is back.
    void this.checkProbeAgents();
    this.agentCheckIntervalId = setInterval(() => {
      void this.checkProbeAgents();
    }, AGENT_CHECK_INTERVAL_MS);

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
    if (this.agentCheckIntervalId) {
      clearInterval(this.agentCheckIntervalId);
      this.agentCheckIntervalId = null;
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
        const settings = {
          name: target.name,
          host: target.host,
          group: target.group,
          probeType: target.probeType,
          ipVersion: target.ipVersion ?? 'auto',
          probeConfig: target.probeConfig,
          probeAgentId: target.probeAgentId ?? null,
          interval: target.interval,
        };

        if (existing) {
          // Updated in place, never replaced: a probe in flight holds this
          // object and clears `isProbing` on it when it finishes. A fresh copy
          // would inherit `isProbing: true` and be skipped forever after.
          Object.assign(existing, settings);
          // A probe in flight has already claimed its slot; restoring the
          // stored timestamp underneath it would schedule a duplicate run.
          if (!existing.isProbing) existing.lastProbeTime = lastProbeTimes.get(target.id) ?? 0;
        } else {
          this.scheduledTargets.set(target.id, {
            id: target.id,
            ...settings,
            lastProbeTime: lastProbeTimes.get(target.id) ?? 0,
            isProbing: false,
          });
        }
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

    const local = targetsToProbe.filter(t => !t.probeAgentId);
    const pingTargets = local.filter(t => t.probeType === 'ping');
    const otherTargets = local.filter(t => t.probeType !== 'ping');

    // Each probe agent's targets queue on their own: a slow or distant agent
    // holds up nothing but itself.
    const byAgent = new Map<string, ScheduledTarget[]>();
    for (const target of targetsToProbe) {
      if (target.probeAgentId) byAgent.set(target.probeAgentId, [...(byAgent.get(target.probeAgentId) ?? []), target]);
    }

    // Pings and the rest are worked through side by side, a few at a time
    // each. An unresponsive HTTP or TCP target spends its whole timeout on
    // every attempt, and in one shared queue a handful of those in a row held
    // up every ping waiting behind them.
    await Promise.all([
      this.probeEach(pingTargets),
      this.probeEach(otherTargets),
      ...[...byAgent.values()].map(targets => this.probeEach(targets, AGENT_CONCURRENCY)),
    ]);
  }

  /** Probe targets individually, with bounded concurrency. */
  private async probeEach(targets: ScheduledTarget[], concurrency = PROBE_CONCURRENCY): Promise<void> {
    let next = 0;

    const worker = async () => {
      while (next < targets.length) {
        await this.probeTarget(targets[next++].id);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, targets.length) }, worker)
    );
  }

  /** Ask every paired probe agent how it is. One pass at a time. */
  private async checkProbeAgents(): Promise<void> {
    if (this.agentCheckInFlight) return;
    this.agentCheckInFlight = true;
    try {
      const agents = await pairedProbeAgentConnections();
      await Promise.all(
        agents.map(async agent => {
          const state = await checkProbeAgent(agent);
          if (state !== agent.state) {
            console.log(`[Scheduler] Probe agent ${agent.name} is now ${state}`);
          }
        })
      );
    } catch (error) {
      console.error('[Scheduler] Probe agent check failed:', error);
    } finally {
      this.agentCheckInFlight = false;
    }
  }

  /**
   * Persist a round of probing and stamp the target's last-probe time.
   *
   * A round is one result, or one per address family for a target probed over
   * both; each is stored as its own measurement.
   *
   * `last_probe_at` is written even when the probe failed. If it were only
   * written on success, `loadTargets()` would keep restoring a stale (or zero)
   * timestamp for an unreachable target and the scheduler would re-probe it on
   * every 10-second tick instead of at its configured interval.
   */
  private async recordResults(
    target: ScheduledTarget,
    results: ProbeResult[]
  ): Promise<void> {
    const db = await getDatabase();
    const round = worstOf(results);

    try {
      for (const result of results) {
        await storeMeasurement(measurementFrom(randomUUID(), result));
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        db.run(
          // A probe that could not resolve the name has no address to report;
          // COALESCE keeps the last one that worked rather than blanking it.
          `UPDATE targets
           SET updated_at = ?, last_probe_at = ?, resolved_address = COALESCE(?, resolved_address)
           WHERE id = ?`,
          [Date.now(), target.lastProbeTime, round.resolvedAddress ?? null, target.id],
          function (err) {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }

    for (const result of results) {
      console.log(
        `[Scheduler] Probe complete for ${target.name}${result.family && results.length > 1 ? ` (IPv${result.family})` : ''}: ` +
        `${result.success ? `${result.latency}ms` : 'FAILED'} ` +
        `(Loss: ${result.packetLoss ?? 0}%)`
      );
    }

    await this.evaluateAndNotify(target, round);
  }

  /**
   * Run the alerts this target is ticked for against the probe result.
   *
   * Alerting must never be able to stop measurements being recorded, so this
   * runs after the measurement is stored and swallows its own failures.
   */
  private async evaluateAndNotify(
    target: ScheduledTarget,
    result: ProbeResult
  ): Promise<void> {
    try {
      const probedFrom = target.probeAgentId ? (await getProbeAgentConnection(target.probeAgentId))?.name : undefined;
      const events = await evaluateAlerts(
        { id: target.id, name: target.name, host: target.host, group: target.group, probedFrom },
        result
      );

      for (const event of events) {
        console.log(
          `[Alerts] ${event.transition.toUpperCase()}: ${event.targetName} ` +
          `${event.metric}=${event.observed ?? 'n/a'} (threshold ${event.threshold})`
        );
        await dispatchAlert(event);
      }

      // The moment an alert fires is the one chance to see the route through
      // whatever went wrong, for the alerts set to trace. Not awaited: a
      // trace through a dead path can take a minute, and the next probe must
      // not wait for it.
      if (events.some(asksForTrace)) {
        if (shouldTraceOnAlert(events, await lastAlertTraceAt(target.id))) {
          console.log(`[Scheduler] Tracing route to ${target.name} after alert`);
          void traceAndStore(target, 'alert').catch(error =>
            console.error(`[Scheduler] Traceroute failed for ${target.name}:`, error)
          );
        } else {
          console.log(`[Scheduler] Not tracing ${target.name} again yet: a trace was taken on an alert recently`);
        }
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

      const results = await runProbes(target);

      // Deleted while it was being probed: nothing to record against.
      if (this.scheduledTargets.get(targetId) !== target) return;

      await this.recordResults(target, results);
      saveDatabaseToDisk();
    } catch (error) {
      // The probe agent, not the target: no reading at all, rather than one
      // saying the target is down. The round is tried again at the target's
      // interval, and is skipped at once while the agent is known to be down.
      if (error instanceof ProbeAgentUnavailableError) {
        console.log(`[Scheduler] Skipped ${target.name}: probe agent ${error.agentName}: ${error.message}`);
        return;
      }
      // A result stored just as its target was deleted fails the foreign key;
      // that is the delete winning the race, not an error.
      const removed = this.scheduledTargets.get(targetId) !== target;
      if (!(removed && (error as { code?: string })?.code === 'SQLITE_CONSTRAINT')) {
        console.error(`[Scheduler] Error probing target ${target.name}:`, error);
      }
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
   * Stop probing these targets now, ahead of their rows being deleted. A probe
   * already under way finds its target gone and drops the result instead of
   * writing a measurement for a target that no longer exists.
   */
  forget(ids: string[]): void {
    for (const id of ids) this.scheduledTargets.delete(id);
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
      await cleanOldTraceroutes(this.retentionDays);
      await cleanOldProbeAgentOutages(this.retentionDays);
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
