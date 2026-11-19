import * as targets from '@/app/api/targets/reorder/route'
import { monitorRoute } from '@/lib/targets/monitor-names'

// /api/targets/reorder, taking and giving monitor names.

export const GET = monitorRoute(targets.GET)
export const PUT = monitorRoute(targets.PUT)
