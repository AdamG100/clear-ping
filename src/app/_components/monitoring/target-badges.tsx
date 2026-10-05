import { cn } from '@/lib/utils'
import type { TargetType } from '@/types/probe'

const TYPE_COLORS: Record<TargetType, string> = {
  ip: 'bg-chart-2/20 text-chart-2',
  domain: 'bg-chart-1/20 text-chart-1',
  dns: 'bg-chart-3/20 text-chart-3',
  tcp: 'bg-chart-4/20 text-chart-4',
  http: 'bg-chart-5/20 text-chart-5',
}

/** What kind of target this is, and so what its readings mean. */
export function TypeBadge({ type }: { type: TargetType }) {
  return (
    <span className={cn('px-1.5 py-0.5 text-[10px] font-medium rounded uppercase', TYPE_COLORS[type])}>
      {type}
    </span>
  )
}

/** Marks a target that is reached over IPv6, the family people have to go looking for. */
export function Ipv6Badge() {
  return (
    <span className="rounded border border-border px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
      v6
    </span>
  )
}

/** Marks a target probed over IPv4 and IPv6 side by side. */
export function DualStackBadge() {
  return (
    <span className="rounded border border-border px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
      v4+v6
    </span>
  )
}
