import * as targets from '@/app/api/targets/route'
import { monitorRoute } from '@/lib/targets/monitor-names'

// /api/targets, taking and giving monitor names.

export const GET = monitorRoute(targets.GET)
export const POST = monitorRoute(targets.POST)
export const DELETE = monitorRoute(targets.DELETE)
