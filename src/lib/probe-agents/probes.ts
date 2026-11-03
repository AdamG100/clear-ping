import { getJsonSetting, setJsonSetting } from '../security/settings-store';
import { findProbeAgent, listProbeAgentSummaries } from './store';
import { DEFAULT_LOCAL_PROBE_NAME, LOCAL_PROBE, type ProbeId, type ProbeSummary } from '@/types/probe-agent';

/**
 * Every place readings are taken from: the local probe, which is the
 * dashboard's own machine, and each probe agent. Server-side only. It reads
 * settings, so nothing the probe agent bundles may import it (the build
 * refuses `settings-store.ts`); the id and its type are in `types/probe-agent.ts`.
 */

const LOCAL_NAME_KEY = 'probes.localName';

/** What the local probe is called: "Local probe" until it is renamed in Settings. */
export async function localProbeName(): Promise<string> {
  const stored = await getJsonSetting<string>(LOCAL_NAME_KEY);
  return typeof stored === 'string' && stored.trim() !== '' ? stored : DEFAULT_LOCAL_PROBE_NAME;
}

/** Rename the local probe; an empty name puts the default back. */
export async function setLocalProbeName(name: string): Promise<string> {
  const trimmed = name.trim().slice(0, 40);
  await setJsonSetting(LOCAL_NAME_KEY, trimmed === '' ? null : trimmed);
  return trimmed === '' ? DEFAULT_LOCAL_PROBE_NAME : trimmed;
}

/** The local probe, then each probe agent by name. */
export async function listProbes(): Promise<ProbeSummary[]> {
  const [name, agents] = await Promise.all([localProbeName(), listProbeAgentSummaries()]);
  return [
    { id: LOCAL_PROBE, name, local: true, state: 'online' },
    ...agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      local: false,
      state: agent.state,
      exposure: agent.exposure,
      address: agent.address,
      hostname: agent.hostname,
      lastSeenAt: agent.lastSeenAt,
    })),
  ];
}

/**
 * The probes here that have these names, as an imported file names them: the
 * local probe by its name or as "local", a probe agent by its name, either
 * ignoring case. Names nothing here has are left out, and the names left out
 * are said, so the import can tell whoever made it.
 */
export async function probesNamed(names: string[], probes?: ProbeSummary[]): Promise<{ probes: ProbeId[]; missing: string[] }> {
  const all = probes ?? (await listProbes());
  const byName = new Map(all.map(probe => [probe.name.trim().toLowerCase(), probe.id]));
  const found: ProbeId[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    const id = key === LOCAL_PROBE ? LOCAL_PROBE : byName.get(key);
    if (id) found.push(id);
    else missing.push(name);
  }
  return { probes: [...new Set(found)], missing };
}

/** What each of some probes is called. One that is gone is named for what it was. */
export async function probeNames(ids: ProbeId[]): Promise<Map<ProbeId, string>> {
  const known = new Map((await listProbes()).map(probe => [probe.id, probe.name]));
  return new Map(ids.map(id => [id, known.get(id) ?? 'A removed probe']));
}

/**
 * Probes a request named: "local" (or null, or empty) for the local probe,
 * otherwise a probe agent by id or, from an assistant, by name. At least one,
 * none twice.
 */
export async function readProbeChoices(
  raw: unknown
): Promise<{ ok: true; probes: ProbeId[] } | { ok: false; error: string }> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'probes must be a list of at least one probe' };
  const probes: ProbeId[] = [];
  for (const entry of raw) {
    if (entry === null || entry === '' || entry === LOCAL_PROBE) {
      probes.push(LOCAL_PROBE);
      continue;
    }
    if (typeof entry !== 'string') return { ok: false, error: 'probes are "local" or a probe agent’s id' };
    const agent = await findProbeAgent(entry);
    if (!agent) return { ok: false, error: `No probe agent called ${entry}` };
    probes.push(agent.id);
  }
  return { ok: true, probes: [...new Set(probes)] };
}

/**
 * Where a request says a monitor is measured from: `probes` (a list), or the
 * older `probeAgentId` (one place, null for the local probe). Undefined when
 * it says neither.
 */
export async function readRequestedProbes(
  body: { probes?: unknown; probeAgentId?: unknown } | null | undefined
): Promise<{ ok: true; probes: ProbeId[] | undefined } | { ok: false; error: string }> {
  if (body?.probes !== undefined) return readProbeChoices(body.probes);
  if (body?.probeAgentId === undefined) return { ok: true, probes: undefined };
  return readProbeChoices([body.probeAgentId]);
}

/** "A", "A and B", "A, B and C". */
function joined(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Where an alert says it was seen from, or nothing when there is nothing to
 * tell: a monitor measured from the local probe alone has always been
 * announced without saying where from. One that fires says which probes are
 * in breach, as a count past three; one that resolves says which probe saw it
 * clear.
 */
export async function probedFromPhrase(event: {
  probe?: ProbeId;
  breaching?: ProbeId[];
  probeCount?: number;
  transition: 'firing' | 'resolved';
}): Promise<string | undefined> {
  const total = event.probeCount ?? 1;
  const probe = event.probe ?? LOCAL_PROBE;
  if (total <= 1 && probe === LOCAL_PROBE) return undefined;

  const ids = event.transition === 'firing' && event.breaching && event.breaching.length > 0 ? event.breaching : [probe];
  if (total > 1 && ids.length > 3) return `${ids.length} of ${total} probes`;
  const names = await probeNames(ids);
  return joined(ids.map(id => names.get(id)!));
}
