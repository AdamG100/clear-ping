import * as targets from '@/app/api/targets/[id]/route'
import { monitorRoute } from '@/lib/targets/monitor-names'

// /api/targets/[id], taking and giving monitor names.

export const GET = monitorRoute(targets.GET)
export const PATCH = monitorRoute(targets.PATCH)
export const DELETE = monitorRoute(targets.DELETE)
