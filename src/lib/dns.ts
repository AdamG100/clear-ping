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

/**
 * Execute multiple DNS probes in sequence
 * Useful for getting distribution data for smoke graph
 */
export async function executeMultipleDnsProbes(
  targetId: string,
  host: string,
  count: number = 20,
  options: DnsOptions = {}
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  for (let i = 0; i < count; i++) {
    const result = await executeDnsProbe(targetId, host, options);
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
