import * as targets from '@/app/api/targets/[id]/measurements/route'
import { monitorRoute } from '@/lib/targets/monitor-names'

// /api/targets/[id]/measurements, taking and giving monitor names.

export const GET = monitorRoute(targets.GET)
