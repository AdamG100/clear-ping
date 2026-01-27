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

export interface ProbeMeasurement {
  id: string;
  targetId: string;
  timestamp: Date;
  latency: number | null; // milliseconds, null if failed
  packetLoss: number; // percentage of packet loss
  jitter: number | null; // milliseconds, variation in latency
  success: boolean;
  errorMessage?: string;
}

export interface DataPoint {
  timestamp: Date;
  latency: number | null;
  packetLoss: number | null;
  jitter: number | null;
  isOnline: boolean | null;
}

export interface MonitoringData {
  targetId: string;
  timeRange: TimeRange;
  data: DataPoint[];
}

export interface ProbeResult {
  targetId: string;
  timestamp: Date;
  latency: number | null;
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
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  packetLoss: number; // percentage
  uptime: number; // percentage
  lastProbe: Date;
  jitter?: number;
}

export const TIME_RANGE_CONFIG: Record<TimeRange, { label: string; points: number; interval: number }> = {
  '1h': { label: 'Recent', points: 60, interval: 1 * 60 * 1000 },
  '3h': { label: '3 Hours', points: 60, interval: 3 * 60 * 1000 },
  '6h': { label: '6 Hours', points: 60, interval: 6 * 60 * 1000 },
  '24h': { label: '24 Hours', points: 96, interval: 15 * 60 * 1000 },
  '7d': { label: '1 Week', points: 168, interval: 60 * 60 * 1000 },
  '30d': { label: '30 Days', points: 180, interval: 4 * 60 * 60 * 1000 },
};
