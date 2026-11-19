import * as targets from '@/app/api/targets/[id]/network/route'
import { monitorRoute } from '@/lib/targets/monitor-names'

// /api/targets/[id]/network, taking and giving monitor names.

export const GET = monitorRoute(targets.GET)
