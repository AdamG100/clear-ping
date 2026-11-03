import type { DnsProtocol, DnsResolver, ProbeConfig } from '@/types/probe';
import type { ProbeId } from '@/types/probe-agent';
import { sameResolver } from '../probes/dns/resolvers';

/**
 * Which probes ask which of a monitor's DNS resolvers.
 *
 * Every probe of a monitor asks all its resolvers, unless a resolver says it is
 * not to be asked from a probe (`notFrom`): one that only answers inside its
 * own network, such as a provider's for its own customers, would otherwise
 * show as failing from everywhere else. The dashboard takes those out before
 * asking a probe, so a probe agent never sees `notFrom` and needs no update.
 *
 * Pure: used in the group dialog as well as the server.
 */

/** One resolver, asked or not from one probe. */
export interface ResolverProbeChange {
  protocol: DnsProtocol;
  server?: string;
  probe: ProbeId;
  asked: boolean;
}

/** A resolver as a probe is given it: nothing about which probes ask it. */
function withoutNotFrom(resolver: DnsResolver): DnsResolver {
  const bare = { ...resolver };
  delete bare.notFrom;
  return bare;
}

/**
 * A monitor's settings as one probe uses them: without the resolvers not asked
 * from it, and with no `notFrom` left in them. Should all of them be left out,
 * which saving refuses, all are asked: a monitor with no resolvers would look
 * up through the machine's own instead, and report something else.
 */
export function configForProbe(config: ProbeConfig | undefined, probe: ProbeId): ProbeConfig | undefined {
  if (!config?.resolvers?.length) return config;
  const asked = config.resolvers.filter(resolver => !resolver.notFrom?.includes(probe));
  const resolvers = (asked.length > 0 ? asked : config.resolvers).map(withoutNotFrom);
  return { ...config, resolvers };
}

/** A monitor's resolvers with these changes made; those not named are left as they are. */
export function changedResolvers(resolvers: DnsResolver[], changes: ResolverProbeChange[]): DnsResolver[] {
  return resolvers.map(resolver => {
    const own = changes.filter(change => sameResolver(change, resolver));
    if (own.length === 0) return resolver;
    const notFrom = new Set(resolver.notFrom ?? []);
    for (const change of own) {
      if (change.asked) notFrom.delete(change.probe);
      else notFrom.add(change.probe);
    }
    const bare = withoutNotFrom(resolver);
    return notFrom.size > 0 ? { ...bare, notFrom: [...notFrom] } : bare;
  });
}

/** The monitor's probes that would be left with no resolver to ask. */
export function probesLeftWithout(resolvers: DnsResolver[], probes: ProbeId[]): ProbeId[] {
  if (resolvers.length === 0) return [];
  return probes.filter(probe => resolvers.every(resolver => resolver.notFrom?.includes(probe)));
}
