import { addressAsn, asName } from '../bgp/ripestat';
import { exchangeData, exchangeOf, memberOf } from '../bgp/exchanges';
import { isPublicAddress } from '../bgp/prefix';
import { knownAsNames, saveNetwork } from '../bgp/store';

/**
 * Who runs an address: the network that holds it, as its ASN and the name it is
 * registered under, and the internet exchange it sits on when it is on one.
 *
 * A private address is never looked up, and nothing here sends anything but
 * the one public address. A peering LAN is usually not announced, so RIPEstat
 * knows nothing of an address on one; the exchange's own member list does, and
 * is asked first.
 */

export type NetworkOf =
  | { address: string; asn: number | null; name: string | null; exchange?: string }
  | { address: string; private: true };

const HELD_MS = 24 * 60 * 60 * 1000;
const held = new Map<string, { at: number; found: NetworkOf }>();

/**
 * The network behind an address, or null when it could not be found out (not
 * remembered, so the next ask tries again).
 */
export async function networkOf(address: string): Promise<NetworkOf | null> {
  if (!isPublicAddress(address)) return { address, private: true };

  const remembered = held.get(address);
  if (remembered && Date.now() - remembered.at < HELD_MS) return remembered.found;

  try {
    const exchanges = await exchangeData().catch(() => null);
    const lan = exchanges ? exchangeOf(address, exchanges.lans) : null;
    const asn = (exchanges ? memberOf(address, exchanges.ports) : null) ?? (await addressAsn(address));
    if (asn === null && !lan) return null;

    let name: string | null = null;
    if (asn !== null) {
      name = (await knownAsNames([asn])).get(asn) ?? null;
      if (name === null) {
        name = await asName(asn).catch(() => null);
        if (name !== null) await saveNetwork(asn, { name, country: null });
      }
    }

    const found: NetworkOf = { address, asn, name, ...(lan ? { exchange: lan.exchange.name } : {}) };
    held.set(address, { at: Date.now(), found });
    return found;
  } catch {
    return null;
  }
}
