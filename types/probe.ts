export type ProbeType = 'ping' | 'dns';

export type ProbeStatus = 'active' | 'paused' | 'error';

export type TimeRange = '1h' | '3h' | '6h' | '24h' | '7d' | '30d';

export type TargetType = 'ip' | 'domain' | 'dns';

export interface Target {
  id: string;
  name: string;
  host: string;
  probeType: ProbeType;
  interval: number; // seconds
  status: ProbeStatus;
  group?: string; // Optional group for organization
  sortOrder?: number; // Order within group
  createdAt: Date;
  updatedAt: Date;
  // Extended fields for UI compatibility
  address?: string;
  type?: TargetType;
  isOnline?: boolean;
  lastCheck?: Date;
  avgLatency?: number;
  packetLoss?: number;
  isNew?: boolean;
}

export interface GroupOrder {
  groupName: string;
  sortOrder: number;
}

export interface ProbeMeasurement {
  id: string;
  targetId: string;
  timestamp: Date;
  latency: number | null; // mean RTT in milliseconds, null if nothing replied
  /** Fastest and slowest individual packet in this probe. */
  minLatency?: number | null;
  maxLatency?: number | null;
  /** Where the packets clustered — the shape the smoke band is drawn from. */
  p10Latency?: number | null;
  p25Latency?: number | null;
  /** True median. The mean lives in `latency` and can fall outside p25-p75. */
  p50Latency?: number | null;
  p75Latency?: number | null;
  p90Latency?: number | null;
  packetLoss: number; // percentage of packet loss
  jitter: number | null; // milliseconds, variation in latency
  success: boolean;
  errorMessage?: string;
}

export interface DataPoint {
  timestamp: Date;
  /** Mean latency across the interval. */
  latency: number | null;
  /** Fastest and slowest reply in the interval — the smoke trace's outer edge. */
  minLatency: number | null;
  maxLatency: number | null;
  /** Inner percentiles; null when the source data predates them. */
  p10Latency: number | null;
  p25Latency: number | null;
  p50Latency: number | null;
  p75Latency: number | null;
  p90Latency: number | null;
  packetLoss: number | null;
  jitter: number | null;
  isOnline: boolean | null;
  /** Number of raw measurements aggregated into this bucket (0 = no data). */
  sampleCount: number;
}

export interface MonitoringData {
  targetId: string;
  timeRange: TimeRange;
  data: DataPoint[];
}

export interface ProbeResult {
  targetId: string;
  timestamp: Date;
  /** Mean RTT across the packets that replied. */
  latency: number | null;
  /** Fastest and slowest individual packet — the outer edge of the smoke band. */
  minLatency?: number | null;
  maxLatency?: number | null;
  /** Inner percentiles, giving the band its density rather than just its edges. */
  p10Latency?: number | null;
  p25Latency?: number | null;
  /** True median, drawn as the trace line. */
  p50Latency?: number | null;
  p75Latency?: number | null;
  p90Latency?: number | null;
  packetLoss?: number; // percentage (0-100)
  jitter?: number | null; // milliseconds, variation in latency
  success: boolean;
  errorMessage?: string;
}

export interface SmokeGraphData {
  timestamp: Date;
  latency: number | null;
  min?: number;
  max?: number;
  avg?: number;
}

export interface TargetStatistics {
  targetId: string;
  /** Number of probes in the window. */
  sampleCount: number;
  /** Latency stats over probes that got at least one reply; null if none did. */
  avgLatency: number | null;
  minLatency: number | null;
  maxLatency: number | null;
  medianLatency: number | null;
  /** Mean per-probe packet loss across the window, 0-100. */
  packetLoss: number;
  minPacketLoss: number;
  maxPacketLoss: number;
  /** Share of probes that got at least one reply, 0-100. Distinct from loss. */
  uptime: number;
  lastProbe: Date | null;
  jitter: number | null;
  minJitter: number | null;
  maxJitter: number | null;
}

/** One aggregated time bucket, produced by SQL rather than in the browser. */
export interface BucketedMeasurement {
  timestamp: Date;
  /** Number of probes folded into this bucket; always at least 1. */
  sampleCount: number;
  latency: number | null;
  minLatency: number | null;
  maxLatency: number | null;
  p10Latency: number | null;
  p25Latency: number | null;
  p50Latency: number | null;
  p75Latency: number | null;
  p90Latency: number | null;
  packetLoss: number;
  maxPacketLoss: number;
  jitter: number | null;
  isOnline: boolean;
}

/** One point in a sidebar sparkline. Timestamps stay numeric to keep the payload small. */
export interface SparklinePoint {
  timestamp: number;
  latency: number | null;
  packetLoss: number;
}

/** Most recent measurement for a target, used for at-a-glance status. */
export interface LatestMeasurement {
  targetId: string;
  timestamp: Date;
  packetLoss: number;
  latency: number | null;
  success: boolean;
}

/**
 * Single source of truth for each time range: how far back it reaches and how
 * wide the chart buckets are. The dashboard derives its query window and its
 * bucketing from this, so the axis, the fetch and the statistics always agree.
 */
export const TIME_RANGE_CONFIG: Record<
  TimeRange,
  { label: string; hours: number; bucketMinutes: number }
> = {
  '1h': { label: '1 Hour', hours: 1, bucketMinutes: 1 },
  '3h': { label: '3 Hours', hours: 3, bucketMinutes: 3 },
  '6h': { label: '6 Hours', hours: 6, bucketMinutes: 5 },
  '24h': { label: '24 Hours', hours: 24, bucketMinutes: 15 },
  '7d': { label: '1 Week', hours: 168, bucketMinutes: 60 },
  '30d': { label: '30 Days', hours: 720, bucketMinutes: 240 },
};

export type AlertMetric = 'packetLoss' | 'latency' | 'jitter' | 'unreachable';

export type AlertState = 'ok' | 'firing';

/**
 * A threshold rule attached to a target.
 *
 * `consecutiveProbes` is what separates an alert from a nuisance: a single
 * probe crossing a threshold is usually a blip, so a rule only fires once the
 * condition has held for that many probes in a row, and only clears after the
 * same number of clean ones.
 */
export interface AlertRule {
  id: string;
  targetId: string;
  metric: AlertMetric;
  /** Threshold value; ignored for the 'unreachable' metric. */
  threshold: number;
  consecutiveProbes: number;
  /** Sent a JSON payload when the rule fires and when it resolves. */
  webhookUrl?: string;
  enabled: boolean;
  state: AlertState;
  /** Consecutive probes that have currently breached (or cleared). */
  streak: number;
  lastFiredAt?: Date | null;
  lastResolvedAt?: Date | null;
  createdAt: Date;
}

export interface AlertEvent {
  rule: AlertRule;
  targetName: string;
  targetHost: string;
  transition: 'firing' | 'resolved';
  metric: AlertMetric;
  observed: number | null;
  threshold: number;
  at: Date;
}

export const ALERT_METRIC_LABELS: Record<AlertMetric, { label: string; unit: string }> = {
  packetLoss: { label: 'Packet loss', unit: '%' },
  latency: { label: 'Latency', unit: 'ms' },
  jitter: { label: 'Jitter', unit: 'ms' },
  unreachable: { label: 'Unreachable', unit: '' },
};
