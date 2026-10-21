import type { BadgeTone } from '@/components/arc/badge/badge'
import type { ProbeAgentExposure, ProbeAgentState } from '@/types/probe-agent'

/** What each probe agent state is called wherever it is shown, and the colour it is shown in. */
export const PROBE_AGENT_STATE: Record<ProbeAgentState, { label: string; tone: BadgeTone }> = {
  online: { label: 'Online', tone: 'success' },
  offline: { label: 'Offline', tone: 'danger' },
  unpaired: { label: 'Not connected', tone: 'neutral' },
  'cert-changed': { label: 'Certificate changed', tone: 'danger' },
  'token-rejected': { label: 'Token refused', tone: 'danger' },
  outdated: { label: 'Update needed', tone: 'warning' },
}

export const PROBE_AGENT_EXPOSURE: Record<ProbeAgentExposure, { label: string; tone: BadgeTone; detail: string }> = {
  tailnet: {
    label: 'Tailnet',
    tone: 'success',
    detail: 'Reached over a tailnet: the port is closed to everything outside it.',
  },
  private: {
    label: 'Private network',
    tone: 'neutral',
    detail: 'Reached over a private network: not open to the internet unless the port is forwarded.',
  },
  public: {
    label: 'Internet',
    tone: 'warning',
    detail: 'Reached over the internet: the link is encrypted, but the port is open to anyone who finds it.',
  },
}
