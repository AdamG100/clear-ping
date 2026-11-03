import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { LOCAL_PROBE, type ProbeId } from '@/types/probe-agent';
import type { TracerouteHop } from '@/types/probe';
import { countryName } from '../bgp/countries';
import { isPublicAddress } from '../bgp/prefix';
import { addressCountry, asCountry } from '../bgp/ripestat';
import { getDatabase } from '../db/database';
import { networkOf } from '../networks/lookup';
import { getPrivacySettings } from '../privacy/settings';
import { listProbeAgents } from './store';

/**
 * Where each probe is, found from its public address: the country it is in
 * and the network it is on. Labels typed in Settings → Probes win over these
 * (places.ts); these fill in whatever is left empty.
 *
 * The address is a probe agent's own, when the dashboard reaches it at a
 * public one. Otherwise, as for the local probe or a probe agent reached over
 * a LAN or a VPN, it is the first hop on the internet in its newest route
 * trace: the provider's router it reaches the internet through, which is in
 * the same country and on the same network. A probe with no public address and
 * no trace yet is not found until one is traced from it.
 *
 * Only that one address leaves the dashboard, to RIPEstat (network-info,
 * as-overview and maxmind-geo-lite), and only while Settings → Privacy →
 * "Look up who runs each address" is on. Server-side only: it reads the
 * database, so nothing the probe agent bundles may import it.
 */

export interface FoundPlace {
  /** The public address it was found from. */
  address: string;
  /** How that address was found. */
  from: 'address' | 'trace';
  /** ISO 3166 code, ZA. */
  country: string | null;
  /** "South Africa". */
  countryName: string | null;
  asn: number | null;
  /** The name the network is registered under. */
  network: string | null;
}

/** Found places are kept this long: a probe rarely moves, and every lookup asks RIPEstat. */
const HELD_MS = 6 * 60 * 60 * 1000;
/** How many of a probe's newest traces are searched for a hop on the internet. */
const TRACES_SEARCHED = 5;

type Held = Map<ProbeId, { at: number; found: FoundPlace | null }>;
// Shared by every route bundle in the process, so one lookup serves them all.
const KEY = Symbol.for('clearping.probe-locations');
function held(): Held {
  const store = globalThis as unknown as Record<symbol, Held | undefined>;
  return (store[KEY] ??= new Map());
}
const looking = new Map<ProbeId, Promise<FoundPlace | null>>();

/** A public address the name or address resolves to, or null. */
async function publicAddressOf(host: string): Promise<string | null> {
  if (isIP(host)) return isPublicAddress(host) ? host : null;
  try {
    const { address } = await lookup(host);
    return isPublicAddress(address) ? address : null;
  } catch {
    return null;
  }
}

/** The first hop on the internet in one of the probe's newest traces. */
async function firstPublicHop(probe: ProbeId): Promise<string | null> {
  const db = await getDatabase();
  const rows = await new Promise<{ hops: string }[]>((resolve, reject) => {
    db.all('SELECT hops FROM traceroutes WHERE probe = ? ORDER BY timestamp DESC LIMIT ?', [probe, TRACES_SEARCHED], (err, found) =>
      err ? reject(err) : resolve((found ?? []) as { hops: string }[])
    );
  }).catch(() => []);
  for (const row of rows) {
    let hops: TracerouteHop[] = [];
    try {
      hops = JSON.parse(row.hops);
    } catch {
      continue;
    }
    const hop = hops.find(each => each.address && isPublicAddress(each.address));
    if (hop?.address) return hop.address;
  }
  return null;
}

async function find(probe: ProbeId, agentHost: string | null): Promise<FoundPlace | null> {
  const own = agentHost ? await publicAddressOf(agentHost) : null;
  const address = own ?? (await firstPublicHop(probe));
  if (!address) return null;

  const network = await networkOf(address);
  const asn = network && !('private' in network) ? network.asn : null;
  // Where the address is used, or else where its network is registered.
  const country = (await addressCountry(address).catch(() => null)) ?? (asn !== null ? await asCountry(asn).catch(() => null) : null);
  return {
    address,
    from: own ? 'address' : 'trace',
    country,
    countryName: country ? countryName(country) : null,
    asn,
    network: network && !('private' in network) ? network.name : null,
  };
}

/**
 * Every probe's found place, by probe id. With `wait`, probes not yet looked
 * up (or looked up too long ago) are looked up first; without it, only what is
 * already known is given and the rest are looked up in the background, for a
 * caller that must not wait on the internet, such as judging an alert.
 */
export async function foundPlaces({ wait = false }: { wait?: boolean } = {}): Promise<Map<ProbeId, FoundPlace>> {
  const known = new Map<ProbeId, FoundPlace>();
  if (!(await getPrivacySettings().catch(() => ({ lookUpNetworks: false }))).lookUpNetworks) return known;

  const agents = await listProbeAgents().catch(() => []);
  const probes: { id: ProbeId; host: string | null }[] = [{ id: LOCAL_PROBE, host: null }, ...agents.map(agent => ({ id: agent.id, host: agent.address }))];
  const now = Date.now();

  await Promise.all(
    probes.map(async ({ id, host }) => {
      const cached = held().get(id);
      // A probe not found is asked again sooner: it may have been traced from since.
      const fresh = cached && now - cached.at < (cached.found ? HELD_MS : HELD_MS / 12);
      if (!fresh) {
        let pending = looking.get(id);
        if (!pending) {
          pending = find(id, host)
            .catch(() => null)
            .then(found => {
              held().set(id, { at: Date.now(), found });
              return found;
            })
            .finally(() => looking.delete(id));
          looking.set(id, pending);
        }
        if (wait) await pending;
      }
      const found = held().get(id)?.found;
      if (found) known.set(id, found);
    })
  );
  return known;
}

/** Forget what was found for a probe, so the next ask looks again: after its address changes. */
export function forgetFoundPlace(probe: ProbeId): void {
  held().delete(probe);
}
