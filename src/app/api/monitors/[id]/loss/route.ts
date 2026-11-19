import * as targets from '@/app/api/targets/[id]/loss/route'
import { monitorRoute } from '@/lib/targets/monitor-names'

// /api/targets/[id]/loss, taking and giving monitor names.

export const GET = monitorRoute(targets.GET)
