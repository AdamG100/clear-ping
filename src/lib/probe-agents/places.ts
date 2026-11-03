import { getJsonSetting, setJsonSetting } from '../security/settings-store';
import type { ProbeId } from '@/types/probe-agent';

/**
 * Where each probe is, in the words its owner chooses: a region ("Europe") and
 * a network ("Example Networks"). Alerts use them to ask that a problem is seen
 * from several regions and networks before it counts, and to say where it was
 * seen. Server-side only: it reads settings, so nothing the probe agent bundles
 * may import it.
 */

const KEY = 'probes.places';

export interface ProbePlace {
  region?: string;
  network?: string;
}

const MAX_LENGTH = 40;

type Stored = Record<string, ProbePlace>;

/** Every probe that has a label, by probe id. */
export async function probePlaces(): Promise<Map<ProbeId, ProbePlace>> {
  const stored = await getJsonSetting<Stored>(KEY);
  return new Map(Object.entries(stored && typeof stored === 'object' ? stored : {}));
}

/** Label a probe; an empty label takes it off. */
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
