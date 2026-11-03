import type { ProbeId } from './probe-agent';

/** One line of a saved comparison: a monitor as one probe measures it. */
export interface ComparisonLine {
  targetId: string;
  probe: ProbeId;
}

/**
 * A named set of lines to draw against each other, whichever groups the
 * monitors are in and whichever probes measure them.
 */
export interface Comparison {
  id: string;
  name: string;
  lines: ComparisonLine[];
  createdAt: number;
  updatedAt: number;
}
