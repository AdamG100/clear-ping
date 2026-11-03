import { NextRequest, NextResponse } from 'next/server';
import { getTargetById } from '@/lib/db/database';
import { initializeServer } from '@/lib/init';
import { networkOf } from '@/lib/networks/lookup';
import { classifyHost, normalizeHost } from '@/lib/probes/host';
import { getPrivacySettings } from '@/lib/privacy/settings';
import { chosenProbe } from '@/lib/targets/probes';

/**
 * GET /api/targets/[id]/network?probe=&family= - Who runs the address it is measured at
 *
 * The address the readings in view were taken against: the host itself when it
 * is an address, otherwise what the name resolved to from that probe over that
 * family. The network is its ASN and registered name, and the exchange when
 * the address is on one. Nothing is looked up while Settings, Privacy has
 * "Look up who runs each address" off, or for a private address.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initializeServer();
    const { id } = await params;
    const target = await getTargetById(id);
    if (!target) return NextResponse.json({ error: 'Target not found' }, { status: 404 });

    if (!(await getPrivacySettings()).lookUpNetworks) return NextResponse.json({ enabled: false, address: null, network: null });

    const query = new URL(request.url).searchParams;
    const host = normalizeHost(target.host);
    const kind = classifyHost(host);
    let address: string | null = null;
    if (kind === 'ipv4' || kind === 'ipv6') address = host;
    // A DNS monitor that asks resolvers measures no address of its own.
    else if (!(target.probeType === 'dns' && (target.probeConfig?.resolvers?.length ?? 0) > 0)) {
      const probe = chosenProbe(target, query.get('probe'));
      const resolved = target.probes?.find(each => each.id === probe)?.resolved;
      const family = query.get('family') === '6' ? 6 : query.get('family') === '4' ? 4 : null;
      address = (family ? resolved?.[family] : resolved?.[4] ?? resolved?.[6]) ?? (probe === (target.probes?.[0]?.id ?? probe) ? target.resolvedAddress ?? null : null);
    }
    if (!address) return NextResponse.json({ enabled: true, address: null, network: null });

    return NextResponse.json({ enabled: true, address, network: await networkOf(address) });
  } catch (error) {
    console.error('Error looking up a network:', error);
    return NextResponse.json({ error: 'Failed to look up the network' }, { status: 500 });
  }
}
