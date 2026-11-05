import { Badge } from '@/components/arc/badge/badge'
import type { TargetType } from '@/types/probe'

const TYPE_LABEL: Record<TargetType, string> = {
  ip: 'IP',
  domain: 'Domain',
  arp: 'ARP',
  dns: 'DNS',
  tcp: 'TCP',
  game: 'Game',
  http: 'HTTP',
}

/** What kind of target this is, and so what its readings mean. */
export function TypeBadge({ type }: { type: TargetType }) {
  return <Badge size="sm" tone={type === 'ip' || type === 'domain' ? 'neutral' : 'info'}>{TYPE_LABEL[type]}</Badge>
}

/** Marks a target that is reached over IPv6, the family people have to go looking for. */
export function Ipv6Badge() {
  return <Badge size="sm">v6</Badge>
}

/** Marks a target probed over IPv4 and IPv6 side by side. */
export function DualStackBadge() {
  return <Badge size="sm">v4+v6</Badge>
}
