import * as targets from '@/app/api/targets/[id]/traceroute/route'
import { monitorRoute } from '@/lib/targets/monitor-names'

// /api/targets/[id]/traceroute, taking and giving monitor names.

export const GET = monitorRoute(targets.GET)
export const POST = monitorRoute(targets.POST)
export const DELETE = monitorRoute(targets.DELETE)
