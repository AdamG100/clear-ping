import { NextRequest, NextResponse } from 'next/server'
import { initializeServer } from '@/lib/init'
import { AlreadyWatchedError, getBgpMonitor } from '@/lib/bgp/monitor'
import { actorFor } from '@/lib/security/access'
import { requireAdmin } from '@/lib/security/http'
import { recordActivity } from '@/lib/security/store'

/**
 * GET /api/bgp - Whether BGP monitoring is on, the connection to RIS Live,
 * and every watched prefix with how it stands.
 */
export async function GET() {
  try {
    await initializeServer()
    return NextResponse.json(await getBgpMonitor().overview())
  } catch (error) {
    console.error('Error reading BGP monitoring:', error)
    return NextResponse.json({ error: 'Failed to read BGP monitoring' }, { status: 500 })
  }
}

/**
 * POST /api/bgp - Watch a prefix: `{ resource, label? }`, where the resource
 * is a prefix, or an address whose announced prefix is watched.
 */
export async function POST(request: NextRequest) {
  try {
    await initializeServer()
    const body = await request.json().catch(() => null)
    const resource = typeof body?.resource === 'string' ? body.resource.trim() : ''
    const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null
    if (!resource) return NextResponse.json({ error: 'Give an IP address or a prefix to watch' }, { status: 400 })

    let added
    try {
      added = await getBgpMonitor().add(resource, label)
    } catch (error) {
      if (error instanceof AlreadyWatchedError) return NextResponse.json({ error: error.message }, { status: 409 })
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not watch that' }, { status: 400 })
    }
    const { actor, via } = await actorFor(request)
    await recordActivity(actor, via, 'bgp.add', added.label ? `${added.prefix} (${added.label})` : added.prefix)
    return NextResponse.json(added, { status: 201 })
  } catch (error) {
    console.error('Error adding a BGP prefix:', error)
    return NextResponse.json({ error: 'Failed to watch the prefix' }, { status: 500 })
  }
}

/**
 * PUT /api/bgp - Turn BGP monitoring on or off, `{ enabled }`, which is a
 * setting and an admin's to change; or set your own network's AS numbers,
 * `{ homeAsns: [64500] }`; or choose the probe agents Routing uses, by those
 * to leave out, `{ excludedAgents: ["<id>"] }`.
 */
export async function PUT(request: NextRequest) {
  try {
    await initializeServer()
    const body = await request.json().catch(() => null)
    if (Array.isArray(body?.homeAsns)) {
      const asns = (body.homeAsns as unknown[]).map(Number)
      if (asns.some(asn => !Number.isInteger(asn) || asn <= 0 || asn > 4_294_967_295) || asns.length > 20) {
        return NextResponse.json({ error: 'Give AS numbers, such as 64500' }, { status: 400 })
      }
      const saved = await getBgpMonitor().setHomeAsns(asns)
      const { actor, via } = await actorFor(request)
      await recordActivity(actor, via, 'bgp.network', saved.length > 0 ? `Your network: ${saved.map(asn => `AS${asn}`).join(', ')}` : 'Your network: none')
      return NextResponse.json(await getBgpMonitor().overview())
    }
    if (Array.isArray(body?.excludedAgents)) {
      const ids = body.excludedAgents as unknown[]
      if (ids.some(id => typeof id !== 'string') || ids.length > 200) {
        return NextResponse.json({ error: 'Give the probe agents to leave out as a list of ids' }, { status: 400 })
      }
      await getBgpMonitor().setExcludedAgents(ids as string[])
      const { actor, via } = await actorFor(request)
      await recordActivity(actor, via, 'bgp.agents', ids.length > 0 ? `${ids.length} probe agent${ids.length === 1 ? '' : 's'} left out of Routing` : 'All probe agents in Routing')
      return NextResponse.json(await getBgpMonitor().overview())
    }
    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json({ error: 'Say whether it is to be on, as { "enabled": true }' }, { status: 400 })
    }
    const admin = await requireAdmin(request)
    if (admin instanceof NextResponse) return admin
    await getBgpMonitor().setEnabled(body.enabled)
    const { actor, via } = await actorFor(request)
    await recordActivity(actor, via, body.enabled ? 'bgp.enable' : 'bgp.disable')
    return NextResponse.json(await getBgpMonitor().overview())
  } catch (error) {
    console.error('Error turning BGP monitoring on or off:', error)
    return NextResponse.json({ error: 'Failed to change BGP monitoring' }, { status: 500 })
  }
}
