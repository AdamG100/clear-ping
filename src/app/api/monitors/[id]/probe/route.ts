import * as targets from '@/app/api/targets/[id]/probe/route'
import { monitorRoute } from '@/lib/targets/monitor-names'

// /api/targets/[id]/probe, taking and giving monitor names.

export const POST = monitorRoute(targets.POST)
