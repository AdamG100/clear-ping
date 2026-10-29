import { NextRequest, NextResponse } from 'next/server'
import { initializeServer } from '@/lib/init'
import { getBgpMonitor } from '@/lib/bgp/monitor'
import { getBgpPrefix } from '@/lib/bgp/store'
import { actorFor } from '@/lib/security/access'
import { recordActivity } from '@/lib/security/store'

type Context = { params: Promise<{ id: string }> }

/** GET /api/bgp/[id] - A watched prefix in full: every peer's route, its timeline and its activity. */
export async function GET(_request: NextRequest, { params }: Context) {
  try {
    await initializeServer()
    const { id } = await params
    const monitor = getBgpMonitor()
    // Started on the way, if it is on and has not yet.
    await monitor.overview()
    const detail = await monitor.detail(id)
    if (!detail) {
      const exists = await getBgpPrefix(id)
      return NextResponse.json(
        { error: exists ? 'BGP monitoring is off' : 'That prefix is not being watched' },
        { status: exists ? 409 : 404 }
      )
    }
    return NextResponse.json(detail)
  } catch (error) {
    console.error('Error reading a BGP prefix:', error)
    return NextResponse.json({ error: 'Failed to read the prefix' }, { status: 500 })
  }
}

/**
 * POST /api/bgp/[id] - Trace your targets inside the prefix now, for the path
 * your own traffic takes to it. Answers once the traces are done.
 */
export async function POST(request: NextRequest, { params }: Context) {
  try {
    await initializeServer()
    const { id } = await params
    const prefix = await getBgpPrefix(id)
    if (!prefix) return NextResponse.json({ error: 'That prefix is not being watched' }, { status: 404 })
    const traced = await getBgpMonitor().traceNow(id)
    if (traced === null) return NextResponse.json({ error: 'BGP monitoring is off' }, { status: 409 })
    const { actor, via } = await actorFor(request)
    await recordActivity(actor, via, 'bgp.trace', prefix.prefix)
    return NextResponse.json({ traced })
  } catch (error) {
    console.error('Error tracing a BGP prefix:', error)
    return NextResponse.json({ error: 'Failed to trace the targets in the prefix' }, { status: 500 })
  }
}

/**
 * PATCH /api/bgp/[id] - `{ label }` to rename it, or `{ acceptNormal: true }`
 * to take how it is carried now as normal.
 */
export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    await initializeServer()
    const { id } = await params
    const body = await request.json().catch(() => null)
    const monitor = getBgpMonitor()
    const prefix = await getBgpPrefix(id)
    if (!prefix) return NextResponse.json({ error: 'That prefix is not being watched' }, { status: 404 })
    const { actor, via } = await actorFor(request)

    if (body?.acceptNormal === true) {
      let accepted
      try {
        accepted = await monitor.acceptAsNormal(id)
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not accept it as normal' }, { status: 400 })
      }
      if (!accepted) return NextResponse.json({ error: 'BGP monitoring is off' }, { status: 409 })
      await recordActivity(actor, via, 'bgp.accept', prefix.prefix)
      return NextResponse.json(accepted)
    }

    if (body && 'label' in body && (body.label === null || typeof body.label === 'string')) {
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null
      await monitor.relabel(id, label)
      await recordActivity(actor, via, 'bgp.change', `${prefix.prefix}: named ${label ?? 'nothing'}`)
      return NextResponse.json({ ...prefix, label })
    }

    return NextResponse.json({ error: 'Say what to change: a label, or acceptNormal' }, { status: 400 })
  } catch (error) {
    console.error('Error changing a BGP prefix:', error)
    return NextResponse.json({ error: 'Failed to change the prefix' }, { status: 500 })
  }
}

/** DELETE /api/bgp/[id] - Stop watching it, and forget what was recorded about it. */
export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    await initializeServer()
    const { id } = await params
    const prefix = await getBgpPrefix(id)
    if (!prefix || !(await getBgpMonitor().remove(id))) {
      return NextResponse.json({ error: 'That prefix is not being watched' }, { status: 404 })
    }
    const { actor, via } = await actorFor(request)
    await recordActivity(actor, via, 'bgp.remove', prefix.prefix)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error removing a BGP prefix:', error)
    return NextResponse.json({ error: 'Failed to stop watching the prefix' }, { status: 500 })
  }
}
