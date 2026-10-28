import { NextRequest, NextResponse } from 'next/server'
import { initializeServer } from '@/lib/init'
import { lookUpResource } from '@/lib/bgp/ripestat'
import { findBgpPrefix } from '@/lib/bgp/store'

/**
 * GET /api/bgp/lookup?resource=203.0.113.10 - What watching an address or
 * prefix would watch: the announced prefix that holds it, who announces it,
 * the announced prefixes around it, and whether it is watched already.
 */
export async function GET(request: NextRequest) {
  try {
    await initializeServer()
    const resource = request.nextUrl.searchParams.get('resource')?.trim() ?? ''
    if (!resource) return NextResponse.json({ error: 'Give an IP address or a prefix' }, { status: 400 })
    let found
    try {
      found = await lookUpResource(resource)
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not look that up' }, { status: 400 })
    }
    return NextResponse.json({ ...found, watched: (await findBgpPrefix(found.prefix)) !== null })
  } catch (error) {
    console.error('Error looking up a BGP resource:', error)
    return NextResponse.json({ error: 'Failed to look that up' }, { status: 500 })
  }
}
