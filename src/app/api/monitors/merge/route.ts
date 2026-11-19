import * as targets from '@/app/api/targets/merge/route'
import { monitorRoute } from '@/lib/targets/monitor-names'

// /api/targets/merge, taking and giving monitor names.

export const GET = monitorRoute(targets.GET)
export const POST = monitorRoute(targets.POST)
