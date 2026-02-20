/**
 * Probe Scheduler Service
 * 
 * Automatically probes targets at their configured intervals, similar to Smokeping.
 * Each target is probed at its set interval (e.g., every 5 minutes), and measurements
 * are captured and stored for visualization on graphs.
 */

import { getAllTargets, storeMeasurement, getDatabase, saveDatabaseToDisk } from './database';
import { executePing, pingMultipleTargets } from './ping';
import { executeDnsProbe } from './dns';
import { randomUUID } from 'crypto';

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
  private checkIntervalMs: number = 10000; // Check every 10 seconds
  private isRunning: boolean = false;

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

    // Load all active targets
    await this.loadTargets();

    // Start the periodic check
    this.intervalId = setInterval(() => {
      this.checkAndProbeTargets();
    }, this.checkIntervalMs);

    // Also reload targets periodically (every 5 minutes) to pick up new targets
    setInterval(() => {
      this.loadTargets();
    }, 5 * 60 * 1000);

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

      // Get last probe times from database
      const db = await getDatabase();
      
      for (const target of activeTargets) {
        // Query last_probe_at from database
        const lastProbeAt = await new Promise<number>((resolve, reject) => {
          db.get('SELECT last_probe_at FROM targets WHERE id = ?', [target.id], (err, row) => {
            if (err) {
              reject(err);
              return;
            }
            resolve((row as any)?.last_probe_at || 0);
          });
        });

        const existing = this.scheduledTargets.get(target.id);
        
        this.scheduledTargets.set(target.id, {
          id: target.id,
          name: target.name,
          host: target.host,
          probeType: target.probeType,
          interval: target.interval,
          lastProbeTime: lastProbeAt,
          isProbing: existing?.isProbing || false,
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
    for (const [targetId, target] of this.scheduledTargets) {
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

    // If we have multiple ping targets, probe them in parallel
    if (targetsToProbe.length > 1) {
      const pingTargets = targetsToProbe.filter(t => t.probeType === 'ping');
      if (pingTargets.length > 1) {
        console.log(`[Scheduler] Probing ${pingTargets.length} ping targets in parallel`);
        await this.probeTargetsParallel(pingTargets);
      }

      // Probe DNS targets and any remaining ping targets sequentially
      const sequentialTargets = targetsToProbe.filter(t => t.probeType === 'dns' || (t.probeType === 'ping' && !pingTargets.includes(t)));
      for (const target of sequentialTargets) {
        await this.probeTarget(target.id);
      }
    } else {
      // Single target or no targets, use original sequential approach
      for (const target of targetsToProbe) {
        await this.probeTarget(target.id);
      }
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
      // Get database instance
      const db = await getDatabase();

      // Prepare target data for parallel pinging
      const targetData = targets.map(target => ({
        id: target.id,
        host: target.host,
      }));

      // Execute parallel pings for better performance
      const results = await pingMultipleTargets(targetData);

      // Process and store results
      for (const result of results) {
        const target = targets.find(t => t.id === result.targetId);
        if (!target) continue;

        // Store the measurement
        const measurement = {
          id: randomUUID(),
          targetId: result.targetId,
          timestamp: result.timestamp,
          latency: result.latency,
          packetLoss: result.packetLoss || 0,
          jitter: result.jitter || null,
          success: result.success,
          errorMessage: result.errorMessage,
        };

        await storeMeasurement(measurement);

        // Update last probe timestamp in database
        await new Promise<void>((resolve, reject) => {
          db.run(
            'UPDATE targets SET updated_at = ?, last_probe_at = ? WHERE id = ?',
            [Date.now(), target.lastProbeTime, target.id],
            function(err) {
              if (err) {
                reject(err);
                return;
              }
              resolve();
            }
          );
        });

        console.log(
          `[Scheduler] Parallel probe complete for ${target.name}: ` +
          `${result.success ? `${result.latency}ms` : 'FAILED'} ` +
          `(Loss: ${result.packetLoss || 0}%)`
        );
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
        target.isProbing = false;
        return;
      }

      // Store the measurement
      const measurement = {
        id: randomUUID(),
        targetId: result.targetId,
        timestamp: result.timestamp,
        latency: result.latency,
        packetLoss: result.packetLoss || 0,
        jitter: result.jitter || null,
        success: result.success,
        errorMessage: result.errorMessage,
      };

      await storeMeasurement(measurement);

      // Update last probe timestamp in database
      const db = await getDatabase();
      await new Promise<void>((resolve, reject) => {
        db.run(
          'UPDATE targets SET updated_at = ?, last_probe_at = ? WHERE id = ?',
          [Date.now(), target.lastProbeTime, target.id],
          function(err) {
            if (err) {
              reject(err);
              return;
            }
            saveDatabaseToDisk();
            resolve();
          }
        );
      });

      console.log(
        `[Scheduler] Probe complete for ${target.name}: ` +
        `${result.success ? `${result.latency}ms` : 'FAILED'} ` +
        `(Loss: ${result.packetLoss || 0}%)`
      );
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

// Singleton instance
let schedulerInstance: ProbeScheduler | null = null;

/**
 * Get the global scheduler instance
 */
export function getScheduler(): ProbeScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new ProbeScheduler();
  }
  return schedulerInstance;
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
  if (schedulerInstance) {
    schedulerInstance.stop();
  }
}
