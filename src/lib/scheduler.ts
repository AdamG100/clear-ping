/**
 * Probe Scheduler Service
 * 
 * Automatically probes targets at their configured intervals, similar to Smokeping.
 * Each target is probed at its set interval (e.g., every 5 minutes), and measurements
 * are captured and stored for visualization on graphs.
 */

import { getAllTargets, storeMeasurements, getNeverAnswered, cleanOldMeasurements } from './db/database';
import { isClosedPortCheck } from './probes/config';
import { checkProbeAgent, ProbeAgentUnavailableError, runProbes } from './probe-agents/client';
import { cleanOldProbeAgentOutages, pairedProbeAgentConnections } from './probe-agents/store';
import { probedFromPhrase } from './probe-agents/probes';
import { logReading } from './probes/log';
import { measurementFrom, worstOf } from './probes/result';
import { agentIdOf, probesOf } from './targets/probes';
import { getPairTimes, pairKey, recordPairRound } from './targets/store';
import { LOCAL_PROBE, type ProbeId } from '@/types/probe-agent';
import type { IpVersion, ProbeConfig, ProbeResult, ProbeType } from '@/types/probe';
import { randomUUID } from 'crypto';
import { cleanOldAlertEvents } from './alerts/history';
import { asksForTrace, dispatchAlert, evaluateAlerts, getAlerts, shouldTraceOnAlert } from './alerts/store';
import { cleanOldTraceroutes, ensureTracerouteSchema, lastAlertTraceAt, traceAndStore, trimAlertTraces } from './traceroute/store';

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

/**
 * How often the scheduler looks for targets that are due. Only a look: what
 * is due is handed to its lane and the look is over, so this can be short
 * enough for each target to be probed close to its own moment.
 */
const CHECK_INTERVAL_MS = 1000;

/**
 * Where in its interval a target is probed, in milliseconds from the start
 * of each interval: the same for a target every time, and different from one
 * target to the next.
 *
 * Probing every target the moment its interval was up lined them up. Targets
 * added together, or caught by the same ten-second look, went off in the same
 * instant for ever after: sixteen probes leaving the machine at once each
 * minute, and nothing in between. A burst like that is the kind of traffic a
 * router queues and drops, so the monitor was making some of the loss it
 * measured. Spread by a hash of the id, they go off one after another.
 */
export function phaseOf(id: string, intervalMs: number): number {
  // FNV-1a over the id, then murmur3's finish: without it, ids that differ
  // only at the end barely move the top bits, and landed side by side.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return ((hash >>> 0) / 0x1_0000_0000) * intervalMs;
}

/**
 * Whether a target last probed at `last` is due at `now`: its moment in an
 * interval later than the one it was last probed in has come. Never probed
 * (`last` 0) is due at once.
 */
export function isDue(now: number, last: number, intervalMs: number, phase: number): boolean {
  if (intervalMs <= 0) return true;
  return Math.floor((now - phase) / intervalMs) > Math.floor((last - phase) / intervalMs);
}

/** When a target last probed at `last` is next due: its moment in the interval after the one it was last probed in. */
export function nextDueAt(last: number, intervalMs: number, phase: number): number {
  if (intervalMs <= 0) return last;
  return (Math.floor((last - phase) / intervalMs) + 1) * intervalMs + phase;
}

/**
 * Jobs run a few at a time, in the order they were given. Each kind of probe
 * has its own, and each probe agent, so a slow one holds up only its own
 * kind; and nothing waits for a lane to empty before the next look.
 */
export class Lane {
  private running = 0;
  private waiting: (() => Promise<void>)[] = [];

  constructor(private readonly size: number) {}

  add(job: () => Promise<void>): void {
    this.waiting.push(job);
    this.next();
  }

  private next(): void {
    while (this.running < this.size && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      this.running++;
      job()
        .catch(error => console.error('[Scheduler] Probe failed:', error))
        .finally(() => {
          this.running--;
          this.next();
        });
    }
  }
}

/**
 * One monitor measured from one probe. A monitor with several probes is
 * several of these, each due at its own moment in the interval and each with
 * its own lane and its own record of having answered.
 */
interface ScheduledTarget {
  id: string;
  /** Where the readings are taken from: the local probe, or a probe agent's id. */
  probe: ProbeId;
  /** The monitor's primary probe, whose resolved address stands for the monitor's. */
  primary: boolean;
  name: string;
  host: string;
  /** Only so an alert can say where the target lives. */
  group?: string;
  probeType: ProbeType;
  ipVersion: IpVersion;
  probeConfig?: ProbeConfig;
  /** The probe agent it is probed from, or null for the local probe. */
  probeAgentId: string | null;
  interval: number; // seconds
  /** The interval in milliseconds, and the target's moment in it: worked out once, not at every look. */
  intervalMs: number;
  phase: number;
  lastProbeTime: number; // timestamp
  /**
   * Whether it has ever answered, once that has been asked of the database:
   * only a closed-port check needs to know, and once it has answered it always
   * has. Asked again whenever the targets are reloaded.
   */
  hasAnswered?: boolean;
  /** Waiting in its lane or being probed: either way, not to be handed over again. */
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
  private isRunning: boolean = false;
  // Pings and the rest are worked through side by side, a few at a time
  // each. An unresponsive HTTP or TCP target spends its whole timeout on
  // every attempt, and in one shared lane a handful of those in a row held
  // up every ping waiting behind them.
  private pingLane = new Lane(PROBE_CONCURRENCY);
  private otherLane = new Lane(PROBE_CONCURRENCY);
  // Each probe agent's targets queue on their own: a slow or distant agent
  // holds up nothing but itself.
  private agentLanes = new Map<string, Lane>();

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

    // Look for what is due every second. A look only hands targets to their
    // lanes and never waits on a probe: when it waited for the whole round,
    // one target timing out held every other target back until it had.
    this.intervalId = setInterval(() => this.queueDueTargets(), CHECK_INTERVAL_MS);

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
      // Every probe's last-probe time in one query rather than one per
      // monitor, read alongside the monitors.
      const [targets, lastProbeTimes] = await Promise.all([getAllTargets(), getPairTimes()]);
      const activeTargets = targets.filter(t => t.status === 'active');

      const live = new Set<string>();
      for (const target of activeTargets) {
        for (const probe of probesOf(target)) {
          const key = pairKey(target.id, probe.id);
          live.add(key);
          const existing = this.scheduledTargets.get(key);
          const settings = {
            probe: probe.id,
            primary: probe.position === 0,
            name: target.name,
            host: target.host,
            group: target.group,
            probeType: target.probeType,
            ipVersion: target.ipVersion ?? 'auto',
            probeConfig: target.probeConfig,
            probeAgentId: agentIdOf(probe.id),
            interval: target.interval,
            intervalMs: target.interval * 1000,
            // The same for all of a monitor's probes: readings taken at the
            // same moment make their comparison, and a quorum of them, fairer.
            // They never share a lane, so nothing is stacked up by it.
            phase: phaseOf(target.id, target.interval * 1000),
            hasAnswered: undefined,
          };

          if (existing) {
            // Updated in place, never replaced: a probe in flight holds this
            // object and clears `isProbing` on it when it finishes. A fresh copy
            // would inherit `isProbing: true` and be skipped forever after.
            Object.assign(existing, settings);
            // Never moved back: a probe in flight has already claimed its
            // interval, and so has a reading taken with Measure now, which is
            // only known here.
            existing.lastProbeTime = Math.max(existing.lastProbeTime, lastProbeTimes.get(key) ?? 0);
          } else {
            this.scheduledTargets.set(key, {
              id: target.id,
              ...settings,
              lastProbeTime: lastProbeTimes.get(key) ?? 0,
              isProbing: false,
            });
          }
        }
      }

      // Remove what no longer exists, is paused, or is no longer measured from there.
      for (const key of [...this.scheduledTargets.keys()]) {
        if (!live.has(key)) this.scheduledTargets.delete(key);
      }

      console.log(`[Scheduler] Loaded ${activeTargets.length} active targets (${this.scheduledTargets.size} to measure)`);
    } catch (error) {
      console.error('[Scheduler] Error loading targets:', error);
    }
  }

  /** The lane a target waits in: its probe agent's, or this server's for its kind. */
  private laneFor(target: ScheduledTarget): Lane {
    if (target.probe === LOCAL_PROBE) return target.probeType === 'ping' ? this.pingLane : this.otherLane;
    let lane = this.agentLanes.get(target.probe);
    if (!lane) {
      lane = new Lane(AGENT_CONCURRENCY);
      this.agentLanes.set(target.probe, lane);
    }
    return lane;
  }

  /** Hand every target whose moment has come to its lane. */
  queueDueTargets(now: number = Date.now()): void {
    for (const [key, target] of this.scheduledTargets) {
      if (target.isProbing) continue;
      if (!isDue(now, target.lastProbeTime, target.intervalMs, target.phase)) continue;

      // Claimed now, so the next look does not hand it over a second time
      // while it waits.
      target.isProbing = true;
      this.laneFor(target).add(() => this.probeTarget(key));
    }
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
    const round = worstOf(results);

    try {
      await storeMeasurements(results.map(result => ({ ...measurementFrom(randomUUID(), result), probe: target.probe })));
    } finally {
      // The probe's own record: when it last measured this, and what each
      // family resolved to from there (a name can resolve differently in
      // different places). A probe that could not resolve the name has no
      // address to report, and the last one that worked is kept rather than
      // blanked. The monitor's own address is its primary probe's.
      await recordPairRound(
        target.id,
        target.probe,
        target.lastProbeTime,
        results.flatMap(result => (result.resolvedAddress ? [{ family: result.family, address: result.resolvedAddress }] : [])),
        { updatedAt: Date.now(), address: target.primary ? round.resolvedAddress ?? null : null }
      );
    }

    for (const result of results) {
      logReading(
        result,
        `[Scheduler] Probe complete for ${target.name}${target.probe !== LOCAL_PROBE ? ` from ${target.probe}` : ''}${result.family && results.length > 1 ? ` (IPv${result.family})` : ''}: ` +
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
      // A closed-port check whose server has never once answered it is a
      // server the check cannot measure, not one that is down: nothing to
      // alert on until it answers, after which silence is an outage again.
      // Whether it has is kept, so the measurements are only searched again
      // while it never has.
      if (isClosedPortCheck(target)) {
        if (result.success) target.hasAnswered = true;
        else {
          // Asked of this probe alone: a server can answer one place and not another.
          target.hasAnswered ??= !(await getNeverAnswered([target.id], target.probe)).has(target.id);
          if (!target.hasAnswered) return;
        }
      }

      const found = await evaluateAlerts(
        { id: target.id, name: target.name, host: target.host, group: target.group, interval: target.interval },
        { ...result, probe: target.probe }
      );
      // Where it was measured from is only looked up for an alert to say so.
      const events = await Promise.all(
        found.map(async event => {
          const probedFrom = await probedFromPhrase(event);
          return probedFrom ? { ...event, probedFrom } : event;
        })
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
      const asking = events.filter(asksForTrace);
      if (asking.length > 0) {
        // From each probe that sees the trouble, up to three: the route
        // through the failure is that probe's own. Each has its pause, since
        // it is the same path whichever alert noticed.
        const tracing = [...new Set(asking.flatMap(event => (event.breaching?.length ? event.breaching : [target.probe])))].slice(0, 3);
        for (const probe of tracing) {
          if (shouldTraceOnAlert(events, await lastAlertTraceAt(target.id, probe))) {
            // One trace answers for every alert that fired. It is kept under the
            // alert that allowed it soonest, which is the one that decided a
            // trace was due.
            const rule = asking.reduce((shortest, event) =>
              event.rule.traceCooldownMinutes < shortest.rule.traceCooldownMinutes ? event : shortest
            ).rule;
            console.log(`[Scheduler] Tracing route to ${target.name}${probe !== LOCAL_PROBE ? ` from ${probe}` : ''} after alert`);
            void traceAndStore({ ...target, probeAgentId: agentIdOf(probe) }, 'alert', undefined, rule.id, probe)
              .then(() => trimAlertTraces(rule.id, rule.traceKeepCount, rule.traceKeepDays))
              .catch(error => console.error(`[Scheduler] Traceroute failed for ${target.name}:`, error));
          } else {
            console.log(`[Scheduler] Not tracing ${target.name} again yet: a trace was taken on an alert recently`);
          }
        }
      }
    } catch (error) {
      console.error(`[Scheduler] Alert evaluation failed for ${target.name}:`, error);
    }
  }

  /**
   * Probe a single target
   */
  private async probeTarget(key: string): Promise<void> {
    const target = this.scheduledTargets.get(key);
    if (!target) return;

    // Mark as probing
    target.isProbing = true;
    target.lastProbeTime = Date.now();

    try {
      const results = await runProbes(target, target.probe);

      // Deleted, or taken off this probe, while it was being probed: nothing
      // to record against.
      if (this.scheduledTargets.get(key) !== target) return;

      await this.recordResults(target, results);
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
      const removed = this.scheduledTargets.get(key) !== target;
      if (!(removed && (error as { code?: string })?.code === 'SQLITE_CONSTRAINT')) {
        console.error(`[Scheduler] Error probing target ${target.name}:`, error);
      }
    } finally {
      target.isProbing = false;
    }
  }

  /**
   * A reading of this target was taken at `at` outside the schedule (Probe
   * now). It stands for the one due in the same interval, which is then not
   * taken: asking for a reading should not get two a few seconds apart.
   */
  noteProbed(targetId: string, at: number, probe?: ProbeId): void {
    for (const target of this.pairsOf(targetId, probe)) target.lastProbeTime = Math.max(target.lastProbeTime, at);
  }

  /** The probes' schedules for a monitor, or for just one of its probes. */
  private pairsOf(targetId: string, probe?: ProbeId): ScheduledTarget[] {
    return [...this.scheduledTargets.values()].filter(pair => pair.id === targetId && (probe === undefined || pair.probe === probe));
  }

  /**
   * Force probe a specific target immediately, from one of its probes or from
   * all of them.
   */
  async forceProbe(targetId: string, probe?: ProbeId): Promise<void> {
    const pairs = this.pairsOf(targetId, probe);
    if (pairs.length === 0) {
      console.warn(`[Scheduler] Target ${targetId} not found in scheduler`);
      return;
    }

    await Promise.all(pairs.map(pair => this.probeTarget(pairKey(pair.id, pair.probe))));
  }

  /**
   * Stop probing these targets now, ahead of their rows being deleted. A probe
   * already under way finds its target gone and drops the result instead of
   * writing a measurement for a target that no longer exists.
   */
  forget(ids: string[]): void {
    const gone = new Set(ids);
    for (const [key, pair] of [...this.scheduledTargets]) {
      if (gone.has(pair.id)) this.scheduledTargets.delete(key);
    }
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
      await cleanOldAlertEvents(this.retentionDays);
      await cleanOldProbeAgentOutages(this.retentionDays);
      for (const alert of await getAlerts()) {
        await trimAlertTraces(alert.id, alert.traceKeepCount, alert.traceKeepDays);
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
    /** Each monitor listed once for each probe it is measured from. */
    targets: Array<{
      id: string;
      probe: ProbeId;
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
      probe: t.probe,
      name: t.name,
      host: t.host,
      interval: t.interval,
      lastProbeTime: t.lastProbeTime,
      nextProbeIn: Math.max(0, nextDueAt(t.lastProbeTime, t.intervalMs, t.phase) - now),
      isProbing: t.isProbing,
    }));

    return {
      isRunning: this.isRunning,
      targetCount: new Set(targets.map(t => t.id)).size,
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
