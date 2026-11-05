import type { ProbeAgentSummary, ProbeId } from './probe-agent';
import type { AlertRuleSettings, ConditionResult, ProbeVerdict } from './alert-rules';

export type ProbeType = 'ping' | 'arp' | 'dns' | 'tcp' | 'game' | 'http';

export type ProbeStatus = 'active' | 'paused' | 'error';

export type TimeRange = '1h' | '3h' | '6h' | '12h' | '24h' | '2d' | '7d' | '30d' | '90d';

export type TargetType = 'ip' | 'domain' | 'arp' | 'dns' | 'tcp' | 'game' | 'http';

/**
 * How a game server probe asks the server how it is: in the game's own query,
 * since a game server says nothing to a packet it does not understand.
 * `source` is the Steam server query (A2S_INFO), `minecraft` Minecraft Java's
 * server list ping (over TCP, the one query here that is), `bedrock`
 * Minecraft Bedrock's RakNet ping, and `quake` the id Tech `getinfo` that
 * FiveM also answers.
 *
 * `unreachable` is for the games that answer nothing at all to anyone outside
 * a match (Call of Duty and the like): it times the server's own "port
 * unreachable" for a port nothing listens on, which many a server that blocks
 * ping still sends (the reply `mtr --udp` gets from its last hop).
 */
export type GameQuery = 'source' | 'minecraft' | 'bedrock' | 'quake' | 'echo' | 'unreachable';

/** The queries of the game's own, sent over UDP. */
export type UdpGameQuery = Exclude<GameQuery, 'minecraft' | 'unreachable'>;

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'TXT';

/**
 * How a resolver is asked. `system` is whatever this machine uses for every
 * other lookup; `udp` is ordinary DNS to a server's address; `dot` is DNS
 * over TLS and `doh` DNS over HTTPS, the two encrypted ways of asking.
 */
export type DnsProtocol = 'system' | 'udp' | 'dot' | 'doh';

/** One resolver a DNS target's name is looked up through. */
export interface DnsResolver {
  protocol: DnsProtocol;
  /**
   * Where it is: an IP address for `udp`, a host (with an optional port) for
   * `dot`, a URL for `doh`. Absent for `system`.
   */
  server?: string;
  /**
   * A name of the user's own for it, shown with the protocol after it. Absent
   * for one that is called by its provider or by where it is.
   */
  name?: string;
  /**
   * The probes that do not ask it, for one that only answers inside its own
   * network. Taken out before a probe is asked, so a probe agent never sees it.
   */
  notFrom?: string[];
}

/** How one resolver answered in one probe of a target that asks several. */
export interface DnsResolverReading {
  /**
   * What the resolver was called when this was taken. A resolver can be
   * renamed afterwards, so where it is still on the target's list it is shown
   * by what it is called now; this is what is left for one that has gone.
   */
  label: string;
  protocol: DnsProtocol;
  /** Where it is. With the protocol, what says which resolver this was, whatever it is called. */
  server?: string;
  /** How many queries it was sent in this probe. */
  sent?: number;
  /** Mean time of the queries it answered; null if it answered none. */
  latency: number | null;
  /** Share of its queries that got no usable answer, 0-100. */
  loss: number;
  /** What it answered with. */
  answers?: string[];
  /** dot, doh: time to open the connection the queries were then sent over. */
  connectMs?: number;
  /** Why its last failed query failed. */
  error?: string;
}

/**
 * Settings that only mean something to one kind of probe. Stored as a single
 * JSON value per target, so a probe that needs a new setting does not need a
 * new column. Fields a target's probe does not use are never stored.
 */
export interface ProbeConfig {
  /**
   * ping: echo requests sent per probe, when not the 20 most targets use.
   * arp: ARP requests, likewise. Loss is counted in whole packets, so this is
   * how finely it is read: one lost of 20 is 5%, one of 100 is 1%.
   */
  packets?: number;
  /** tcp: the port to connect to. game: the port to query. http: the port, when not the scheme's default. */
  port?: number;
  /** game: which query the server speaks. */
  gameQuery?: GameQuery;
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
  /**
   * dns: the record type to ask for, of a server target or of a name target's
   * own resolvers. For a name, which of A and AAAA is asked for follows the
   * target's IP version where that is set.
   */
  recordType?: DnsRecordType;
  /** dns: a value the answer must include, such as the address a name should resolve to. */
  expectedAnswer?: string;
  /**
   * dns, name targets: the resolvers to look the name up through, each of them
   * on every probe. Absent for the system resolver alone.
   */
  resolvers?: DnsResolver[];
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
  /** dns, with several resolvers: how each of them did, in the order they are listed. */
  resolvers?: DnsResolverReading[];
  /** game: what the server said about itself. */
  gameServer?: GameServerInfo;
}

/** What a game server says about itself in answer to a query. Each field only if it said it. */
export interface GameServerInfo {
  name?: string;
  /** The game, or the mode it is running, as the server names it. */
  game?: string;
  map?: string;
  players?: number;
  maxPlayers?: number;
  version?: string;
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

/** One probe a monitor is measured from, in the order they were chosen. */
export interface TargetProbe {
  id: ProbeId;
  /** 0 for the primary probe, the one the page opens on. */
  position: number;
  /** The address each family last resolved to from there, for a name. */
  resolved?: Partial<Record<AddressFamily, string>>;
  /** Taken off the monitor: its readings stay until they age out, but it takes no more. */
  former?: boolean;
}

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
  /**
   * The probe agent this target is probed from, or none for this server.
   * Belongs to this installation, so it is not part of a TargetDefinition and
   * never travels in a share link. With several probes this is the primary
   * one (the first of `probes`), which older clients and the API still read.
   */
  probeAgentId?: string | null;
  /**
   * Every probe it is measured from, primary first. Absent on a target built
   * by hand, which reads as its `probeAgentId` alone.
   */
  probes?: TargetProbe[];
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
  /** The probe agent it is probed from, as the page shows it. */
  probeAgent?: ProbeAgentSummary;
  /** Why no readings are being taken although it is not paused: its probe agent is down. */
  onHold?: string;
  /**
   * A closed-port check that has never had an answer since it was added: a
   * server this check cannot measure, shown grey rather than as down.
   */
  neverAnswered?: boolean;
  /** Being deleted: still listed until the server is done, but greyed and out of reach. */
  deleting?: boolean;
}

/**
 * Everything that makes a target what it is, and nothing that belongs to one
 * installation: no id, no status, no history. It is what adding a target
 * takes, and so also what a share link carries from one ClearPing to another.
 */
export interface TargetDefinition {
  name: string;
  host: string;
  probeType: ProbeType;
  ipVersion: IpVersion;
  probeConfig: ProbeConfig;
  interval: number; // seconds
  /** The group it sits in, as a path; absent for none. */
  group?: string;
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
  /** The probe it was taken from; the local probe when absent. */
  probe?: ProbeId;
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
  /** The probe the reading was taken from; the local probe when absent. */
  probe?: ProbeId;
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
  /** The middle eight in ten of the latencies: where they usually are, without the outliers. */
  latencyP10: number | null;
  latencyP90: number | null;
  /** Mean per-probe packet loss across the window, 0-100. */
  packetLoss: number;
  minPacketLoss: number;
  maxPacketLoss: number;
  /** Share of probes that got at least one reply, 0-100. Distinct from loss. */
  uptime: number;
  /** Probes that got something back, and not everything. */
  lossyProbes: number;
  /** Probes that got nothing back at all. */
  failedProbes: number;
  /** Probes in each band of PACKET_LOSS_BANDS, best first; one that got nothing back is in the last. */
  lossBands: number[];
  lastProbe: Date | null;
  /** Mean jitter across the window. */
  jitter: number | null;
  minJitter: number | null;
  maxJitter: number | null;
  medianJitter: number | null;
  jitterP10: number | null;
  jitterP90: number | null;
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
  /**
   * Set for a monitor measured from several probes: each one's newest reading
   * (with its own `byFamily`). The fields above then describe them together:
   * reachable if any probe reaches it, with the loss of the worst.
   */
  byProbe?: Record<ProbeId, ProbeReading>;
}

/** One family's share of a dual-stack target's latest reading. */
export type FamilyReading = Omit<LatestMeasurement, 'byFamily' | 'byProbe'>;

/** One probe's share of a monitor's latest reading. */
export type ProbeReading = Omit<LatestMeasurement, 'byProbe'>;

/**
 * One line on a comparison chart: a target, or one address family of a target
 * that is probed over both.
 */
export interface ComparisonSeries {
  targetId: string;
  /** The probe the line was measured from. */
  probe?: ProbeId;
  /** Null when the target is not split by family. */
  family: AddressFamily | null;
  /** Set when the line is one resolver of a DNS target that asks several. */
  resolver?: string;
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
 * A recorded traceroute. `alert` ones are taken automatically at the moment an
 * alert set to trace fires, which is the only time the route through a
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
  /** The alert that took this route, when it was taken because an alert fired. */
  alertId?: string;
  /** The probe it was traced from; the local probe when absent. */
  probe?: ProbeId;
}

/**
 * Each time range a chart can be set to, shortest first: what it is called and
 * how far back it reaches. How finely a range is drawn is not set here: the
 * server works that out from the length of the period (see `bucketWidthFor`).
 *
 * The longest is the 90 days that measurements are kept for unless
 * CLEARPING_RETENTION_DAYS says otherwise.
 */
export const TIME_RANGE_CONFIG: Record<TimeRange, { label: string; hours: number }> = {
  '1h': { label: '1 Hour', hours: 1 },
  '3h': { label: '3 Hours', hours: 3 },
  '6h': { label: '6 Hours', hours: 6 },
  '12h': { label: '12 Hours', hours: 12 },
  '24h': { label: '24 Hours', hours: 24 },
  '2d': { label: '2 Days', hours: 48 },
  '7d': { label: '1 Week', hours: 168 },
  '30d': { label: '30 Days', hours: 720 },
  '90d': { label: '90 Days', hours: 2160 },
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
export interface AlertSettings extends AlertRuleSettings {
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
  /**
   * Trace the route to the target when this alert fires on it. The moment a
   * path is losing packets or has gone dark is usually the only chance to see
   * where; by the time anyone looks it has often mended. Only for the metrics
   * in TRACEABLE_ALERT_METRICS.
   */
  traceOnFire: boolean;
  /**
   * The least time between traces taken on alerts for the same target, in
   * minutes. A link that drops in and out fires again and again, and each
   * trace through a dead path is a minute and a half of probes: one trace per
   * spell of trouble is what is useful.
   */
  traceCooldownMinutes: number;
  /**
   * How many routes this alert keeps for each target it traces. Older ones,
   * past this many newest, are deleted. A route traced by hand is not one of
   * these.
   */
  traceKeepCount: number;
  /** Delete routes this alert took once they are older than this many days. */
  traceKeepDays: number;
  /** Also send this alert's notification URLs a message when a probe agent goes offline, and when it is back. */
  probeAgentOffline?: boolean;
}

/** Alerts that can trace the route when they fire: the ones a path being broken or congested explains. */
export const TRACEABLE_ALERT_METRICS: readonly AlertMetric[] = ['packetLoss', 'unreachable', 'latency', 'jitter'];

/**
 * Whether a new alert traces when it fires, unless it says otherwise: those
 * on loss and on a target going down, which always used to.
 */
export function tracesByDefault(metric: AlertMetric): boolean {
  return metric === 'packetLoss' || metric === 'unreachable';
}

export const DEFAULT_TRACE_COOLDOWN_MINUTES = 15;
export const MAX_TRACE_COOLDOWN_MINUTES = 24 * 60;

/** How many routes a new alert keeps for each target, until someone says otherwise. */
export const DEFAULT_TRACE_KEEP_COUNT = 10;
export const MAX_TRACE_KEEP_COUNT = 100;
/** How long a new alert keeps the routes it takes, in days. */
export const DEFAULT_TRACE_KEEP_DAYS = 30;
export const MAX_TRACE_KEEP_DAYS = 365;

/** How one target currently stands against an alert it is ticked for. */
export interface AlertTargetState {
  targetId: string;
  state: AlertState;
  /** Consecutive probes that have currently breached (or cleared). */
  streak: number;
  lastFiredAt?: Date | null;
  lastResolvedAt?: Date | null;
  /** The probes that see it breached while it fires: the ones holding it open. */
  breachingProbes?: ProbeId[];
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
  /** Where it was measured from, in words, when that is worth saying: a probe agent, or several probes. */
  probedFrom?: string;
  /** The probe whose reading caused this; the local probe when absent. */
  probe?: ProbeId;
  /** The probes in breach once this reading was judged. */
  breaching?: ProbeId[];
  /** How many probes measure the monitor. */
  probeCount?: number;
  transition: 'firing' | 'resolved';
  metric: AlertMetric;
  observed: number | null;
  threshold: number;
  at: Date;
  /** Each condition as it stood, when the alert has more than one or says why. */
  conditions?: ConditionResult[];
  /** Each probe's part, when the monitor has several. */
  probeVerdicts?: ProbeVerdict[];
  /** What most likely broke, from the readings of the probes in breach: "the connection was refused". */
  cause?: string;
  /** How the policy came out: "at least 4 of 7 probes: 5 in breach". */
  policyText?: string;
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
