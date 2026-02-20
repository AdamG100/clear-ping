import { promises as dns } from 'dns';
import { ProbeResult } from '@/types/probe';

interface DnsOptions {
  recordType?: 'A' | 'AAAA' | 'MX' | 'TXT' | 'NS' | 'CNAME';
  timeout?: number; // milliseconds
}

/**
 * Execute a DNS probe to resolve a hostname
 * Returns the DNS resolution latency in milliseconds
 */
export async function executeDnsProbe(
  targetId: string,
  host: string,
  options: DnsOptions = {}
): Promise<ProbeResult> {
  const { recordType = 'A', timeout = 5000 } = options;
  const timestamp = new Date();
  const latencies: number[] = [];

  // Perform multiple DNS queries to calculate jitter
  const queryCount = 5;
  let successCount = 0;

  for (let i = 0; i < queryCount; i++) {
    const startTime = Date.now();

    try {
      // Create a timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('DNS query timed out')), timeout);
      });

      // Execute DNS lookup
      const lookupPromise = dns.resolve(host, recordType);

      // Race between lookup and timeout
      await Promise.race([lookupPromise, timeoutPromise]);

      const endTime = Date.now();
      const latency = endTime - startTime;
      latencies.push(latency);
      successCount++;

    } catch (error) {
      // DNS query failed - don't record latency for failed queries
      // This ensures jitter is only calculated from successful measurements
    }

    // Small delay between queries to avoid overwhelming DNS servers
    if (i < queryCount - 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  // Calculate average latency only from successful queries
  const avgLatency = successCount > 0 ? latencies.reduce((sum, lat) => sum + lat, 0) / successCount : null;

  // Calculate jitter as Mean Absolute Deviation from successful queries only
  let jitter: number | null = null;
  if (successCount > 1) {
    const mean = latencies.reduce((sum, lat) => sum + lat, 0) / successCount;
    const absoluteDeviations = latencies.map(lat => Math.abs(lat - mean));
    jitter = Math.round(absoluteDeviations.reduce((sum, dev) => sum + dev, 0) / absoluteDeviations.length);
  }

  const success = successCount > 0;

  return {
    targetId,
    timestamp,
    latency: avgLatency,
    jitter,
    success,
  };
}

/**
 * Execute a single DNS probe to resolve a hostname
 * Returns the DNS resolution latency in milliseconds
 */
async function executeSingleDnsProbe(
  targetId: string,
  host: string,
  options: DnsOptions = {}
): Promise<ProbeResult> {
  const { recordType = 'A', timeout = 5000 } = options;
  const timestamp = new Date();
  const startTime = Date.now();

  try {
    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('DNS query timed out')), timeout);
    });

    // Execute DNS lookup
    const lookupPromise = dns.resolve(host, recordType);

    // Race between lookup and timeout
    await Promise.race([lookupPromise, timeoutPromise]);

    const endTime = Date.now();
    const latency = endTime - startTime;

    return {
      targetId,
      timestamp,
      latency,
      success: true,
    };

  } catch (error) {
    const endTime = Date.now();
    const latency = endTime - startTime;

    // Still return latency if query failed but completed
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      targetId,
      timestamp,
      latency: latency < timeout ? latency : null,
      success: false,
      errorMessage,
    };
  }
}
export async function executeMultipleDnsProbes(
  targetId: string,
  host: string,
  count: number = 20,
  options: DnsOptions = {}
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  for (let i = 0; i < count; i++) {
    const result = await executeSingleDnsProbe(targetId, host, options);
    results.push(result);
    
    // Small delay between probes to avoid overwhelming DNS servers
    if (i < count - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}

/**
 * Check if a hostname is valid for DNS probing
 */
export function isValidHostname(host: string): boolean {
  // Basic hostname validation
  const hostnameRegex = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)*[a-zA-Z0-9][a-zA-Z0-9-_]+\.[a-zA-Z]{2,11}?$/;
  return hostnameRegex.test(host);
}
