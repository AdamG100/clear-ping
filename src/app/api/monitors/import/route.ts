import * as targets from '@/app/api/targets/import/route'
import { monitorRoute } from '@/lib/targets/monitor-names'

// /api/targets/import, taking and giving monitor names.

export const POST = monitorRoute(targets.POST)
