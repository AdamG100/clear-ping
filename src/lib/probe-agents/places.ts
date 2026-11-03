import { getJsonSetting, setJsonSetting } from '../security/settings-store';
import type { ProbeId } from '@/types/probe-agent';
import { foundPlaces } from './location';

/**
 * Where each probe is: a region ("South Africa") and a network ("Example
 * Networks"). Alerts use them to ask that a problem is seen from several
 * regions and networks before it counts, and to say where it was seen.
 *
 * Each is found from the probe's public address (location.ts): its country as
 * the region, and the name its network is registered under. A label typed in
 * Settings → Probes wins over what was found, for a probe whose address says
 * the wrong thing (one behind a VPN, say) or to group places more broadly
 * ("Europe"). Server-side only: it reads settings, so nothing the probe agent
 * bundles may import it.
 */

const KEY = 'probes.places';

export interface ProbePlace {
  region?: string;
  network?: string;
}

const MAX_LENGTH = 40;

type Stored = Record<string, ProbePlace>;

/** The labels typed in for each probe, by probe id: only what was typed, nothing found. */
export async function labelledPlaces(): Promise<Map<ProbeId, ProbePlace>> {
  const stored = await getJsonSetting<Stored>(KEY);
  return new Map(Object.entries(stored && typeof stored === 'object' ? stored : {}));
}

/**
 * Where every probe is, by probe id: its labels, with what was found from its
 * address where a label is empty. Never waits on a lookup (see foundPlaces),
 * so judging an alert is not held up by the internet.
 */
export async function probePlaces(): Promise<Map<ProbeId, ProbePlace>> {
  const [labelled, found] = await Promise.all([labelledPlaces(), foundPlaces().catch(() => new Map())]);
  const places = new Map<ProbeId, ProbePlace>();
  for (const id of new Set([...labelled.keys(), ...found.keys()])) {
    const label = labelled.get(id) ?? {};
    const seen = found.get(id);
    const region = label.region ?? seen?.countryName ?? undefined;
    const network = label.network ?? seen?.network ?? undefined;
    if (region || network) places.set(id, { ...(region ? { region } : {}), ...(network ? { network } : {}) });
  }
  return places;
}

/** Label a probe; an empty label takes it off, and what was found from its address shows again. */
export async function setProbePlace(probe: ProbeId, place: ProbePlace): Promise<ProbePlace> {
  const tidy = (text: string | undefined) => {
    const trimmed = (text ?? '').trim().slice(0, MAX_LENGTH);
    return trimmed === '' ? undefined : trimmed;
  };
  const next: ProbePlace = { region: tidy(place.region), network: tidy(place.network) };
  const stored: Stored = { ...((await getJsonSetting<Stored>(KEY)) ?? {}) };
  if (next.region || next.network) stored[probe] = { ...(next.region ? { region: next.region } : {}), ...(next.network ? { network: next.network } : {}) };
  else delete stored[probe];
  await setJsonSetting(KEY, Object.keys(stored).length > 0 ? stored : null);
  return stored[probe] ?? {};
}
