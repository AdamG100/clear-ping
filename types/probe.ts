export type ProbeType = 'ping' | 'dns' | 'tcp' | 'http';

export type ProbeStatus = 'active' | 'paused' | 'error';

export type TimeRange = '1h' | '3h' | '6h' | '24h' | '7d' | '30d';

export type TargetType = 'ip' | 'domain' | 'dns' | 'tcp' | 'http';

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'TXT';

/**
 * Settings that only mean something to one kind of probe. Stored as a single
 * JSON value per target, so a probe that needs a new setting does not need a
 * new column. Fields a target's probe does not use are never stored.
 */
export interface ProbeConfig {
  /** tcp: the port to connect to. http: the port, when not the scheme's default. */
  port?: number;
  /** http */
  scheme?: 'http' | 'https';
  /** http: path and query, starting with `/`. */
  path?: string;
  /** http: the exact status a healthy response has. Unset accepts any 2xx or 3xx. */
  expectedStatus?: number;
  /** http: text the response body must contain. */
  keyword?: string;
  /** dns, server targets: the name to ask the server for. */
  queryName?: string;
  /** dns, server targets: the record type to ask for. */
  recordType?: DnsRecordType;
  /** dns: a value the answer must include, such as the address a name should resolve to. */
  expectedAnswer?: string;
}

/**
 * What a probe learned beyond its timings. Kept with each measurement so the
 * latest reading can explain itself: which status came back, where the time
 * went, when the certificate runs out.
 */
export interface ProbeDetails {
  /** http: status of the last response received. */
  statusCode?: number;
  /** http: mean time to open the TCP connection, in milliseconds. */
  connectMs?: number;
  /** https: mean time for the TLS handshake. */
  tlsMs?: number;
  /** http: mean time from sending the request to the first byte of the response. */
  waitMs?: number;
  /** https: when the server's certificate stops being valid, in epoch milliseconds. */
  certExpiresAt?: number;
  /** dns: the answer to the last query that got one. */
  answers?: string[];
}

/** An explicit span of time, in epoch milliseconds: what a chart zoom selects. */
export interface TimeWindow {
  start: number;
  end: number;
}

/**
 * Which address family a target named by a domain is probed over. `auto` takes
 * whichever address the system resolver lists first. `both` probes the name
 * over IPv4 and over IPv6 every time and keeps the two as separate series, so
 * one family failing or slowing down is visible beside the other. An IP
 * literal fixes its own family, so the setting has no effect there.
 */
export type IpVersion = 'auto' | 'ipv4' | 'ipv6' | 'both';

/** What a single probe can be pinned to: `both` is two probes, not one. */
export type ProbeIpVersion = Exclude<IpVersion, 'both'>;

export type AddressFamily = 4 | 6;

export interface Target {
  id: string;
  name: string;
  host: string;
  probeType: ProbeType;
  interval: number; // seconds
  status: ProbeStatus;
  group?: string; // Optional group for organization
  sortOrder?: number; // Order within group
  ipVersion?: IpVersion;
  /** Address the most recent probe of a domain target resolved to and measured. */
  resolvedAddress?: string;
  probeConfig?: ProbeConfig;
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
  /** How each address family is doing, for a target probed over both. */
  statusNote?: string;
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
  details?: ProbeDetails;
  /** The address family this reading was taken over, when it is known. */
  family?: AddressFamily;
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
  /** Set when the target is a domain: the address this probe actually measured. */
  resolvedAddress?: string;
  details?: ProbeDetails;
  /** The address family the probe ran over, when it is known. */
  family?: AddressFamily;
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
  /** Why the probe failed, when it did. */
  errorMessage?: string;
  details?: ProbeDetails;
  /**
   * Set for a target probed over both families: the newest reading of each.
   * The fields above then describe the two together, reachable if either is
   * and with the loss of the worse one, so a row that is half down looks it.
   */
  byFamily?: Partial<Record<AddressFamily, FamilyReading>>;
}

/** One family's share of a dual-stack target's latest reading. */
export type FamilyReading = Omit<LatestMeasurement, 'byFamily'>;

/**
 * One line on a comparison chart: a target, or one address family of a target
 * that is probed over both.
 */
export interface ComparisonSeries {
  targetId: string;
  /** Null when the target is not split by family. */
  family: AddressFamily | null;
  buckets: BucketedMeasurement[];
  statistics: TargetStatistics | null;
}

/** One router on the way to a target, as seen by a traceroute. */
export interface TracerouteHop {
  hop: number;
  /** Null when the router never identified itself. */
  address: string | null;
  /**
   * The router's name from reverse DNS. Null when it has none; absent while
   * the lookup is still running, which it does after the trace itself is done.
   */
  hostname?: string | null;
  /** Round-trip times of the packets that came back, in milliseconds. */
  rtts: number[];
  /** Packets sent to this hop. */
  sent: number;
}

/**
 * A recorded traceroute. `alert` ones are taken automatically at the moment a
 * loss or unreachable alert fires, which is the only time the route through a
 * failure can be captured: by the time anyone looks, it has usually recovered.
 */
export interface Traceroute {
  id: string;
  targetId: string;
  timestamp: Date;
  trigger: 'manual' | 'alert';
  /** The address that was traced: the target's, or what its name resolved to. */
  address: string;
  hops: TracerouteHop[];
  /** Whether the final hop was the address being traced. */
  reached: boolean;
  errorMessage?: string;
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

export type AlertMetric = 'packetLoss' | 'latency' | 'jitter' | 'unreachable' | 'certExpiry';

export type AlertState = 'ok' | 'firing';

/**
 * What an alert watches for and where it says so.
 *
 * `consecutiveProbes` is what separates an alert from a nuisance: a single
 * probe crossing a threshold is usually a blip, so an alert only fires once
 * the condition has held for that many probes in a row, and only clears after
 * the same number of clean ones.
 */
export interface AlertSettings {
  /** What to call it. An alert without one is described by its condition. */
  name?: string;
  metric: AlertMetric;
  /** Threshold value; ignored for the 'unreachable' metric. */
  threshold: number;
  consecutiveProbes: number;
  /**
   * Where it is sent when it fires and when it resolves: Apprise URLs, one for
   * each service to notify (`discord://…`, `mailto://…`, `json://…`). What
   * kind of service each one is, and how to word a message for it, is
   * Apprise's business. Empty for an alert that is only shown in the app.
   */
  notifyUrls: string[];
}

/** How one target currently stands against an alert it is ticked for. */
export interface AlertTargetState {
  targetId: string;
  state: AlertState;
  /** Consecutive probes that have currently breached (or cleared). */
  streak: number;
  lastFiredAt?: Date | null;
  lastResolvedAt?: Date | null;
}

/**
 * An alert: one condition, watched on every target ticked for it. Each of
 * those targets fires and resolves on its own.
 */
export interface Alert extends AlertSettings {
  id: string;
  enabled: boolean;
  createdAt: Date;
  targets: AlertTargetState[];
}

/** An alert as it applies to a single target: what a probe is judged against. */
export interface AlertRule extends AlertSettings, AlertTargetState {
  /** The alert's id; with `targetId`, what identifies this rule. */
  id: string;
  enabled: boolean;
  createdAt: Date;
}

export interface AlertEvent {
  rule: AlertRule;
  targetName: string;
  targetHost: string;
  /** The group the target is in, as a path; absent for a target with none. */
  targetGroup?: string;
  transition: 'firing' | 'resolved';
  metric: AlertMetric;
  observed: number | null;
  threshold: number;
  at: Date;
}

/**
 * `comparison` is the side of the threshold that is a problem. Every metric
 * but one is bad when it climbs; a certificate's remaining life is bad when it
 * runs down.
 */
export const ALERT_METRIC_LABELS: Record<
  AlertMetric,
  { label: string; unit: string; comparison: 'above' | 'below' }
> = {
  packetLoss: { label: 'Packet loss', unit: '%', comparison: 'above' },
  latency: { label: 'Latency', unit: 'ms', comparison: 'above' },
  jitter: { label: 'Jitter', unit: 'ms', comparison: 'above' },
  unreachable: { label: 'Unreachable', unit: '', comparison: 'above' },
  certExpiry: { label: 'Certificate expires in', unit: ' days', comparison: 'below' },
};
