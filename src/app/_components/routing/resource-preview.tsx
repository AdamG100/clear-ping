'use client'

import { useEffect, useState } from 'react'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { isAddress, isPrefix } from '@/lib/bgp/prefix'

/**
 * What watching an address or prefix would watch, shown as it is typed: the
 * announced prefix that holds it (an address in a provider's space is part
 * of one of its announcements, and which is not always plain), who announces
 * it, and the announced prefixes around it.
 */

interface Related {
  prefix: string
  asn: number
  name: string | null
}

interface Lookup {
  prefix: string
  address: string | null
  announcedBy: { asn: number; name: string | null }[]
  within: Related[]
  inside: Related[]
  watched: boolean
}

const WAIT_MS = 600

function network(asn: number, name: string | null): string {
  return name ? `AS${asn} ${name}` : `AS${asn}`
}

function RelatedList({ title, items }: { title: string; items: Related[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-xs text-muted-foreground">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {items.slice(0, 6).map(item => (
          <li key={`${item.prefix}-${item.asn}`} className="text-xs">
            <span className="font-mono">{item.prefix}</span>
            <span className="text-muted-foreground"> by {network(item.asn, item.name)}</span>
          </li>
        ))}
        {items.length > 6 && <li className="text-xs text-muted-foreground">and {items.length - 6} more</li>}
      </ul>
    </div>
  )
}

export function ResourcePreview({ resource }: { resource: string }) {
  const given = resource.trim()
  const valid = isAddress(given) || isPrefix(given)
  const [state, setState] = useState<{ for: string; lookup: Lookup | null; error: string | null } | null>(null)

  useEffect(() => {
    if (!valid) return
    let current = true
    // Asked once typing has paused, not at every key.
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/bgp/lookup?resource=${encodeURIComponent(given)}`)
        const body = await response.json().catch(() => null)
        if (!current) return
        setState(response.ok ? { for: given, lookup: body as Lookup, error: null } : { for: given, lookup: null, error: body?.error ?? 'Could not look that up' })
      } catch {
        if (current) setState({ for: given, lookup: null, error: 'Could not look that up' })
      }
    }, WAIT_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [given, valid])

  if (!valid) return null
  if (!state || state.for !== given) {
    return (
      <div className="rounded-2xl border border-border p-3" aria-live="polite">
        <Skeleton label="Looking it up" lines={2} />
      </div>
    )
  }
  if (state.error || !state.lookup) {
    return <p className="rounded-2xl border border-signal-moderate/40 p-3 text-xs text-signal-moderate" aria-live="polite">{state.error}</p>
  }
  const { lookup } = state
  return (
    <div className="space-y-3 rounded-2xl border border-primary/40 bg-primary/5 p-3" aria-live="polite">
      <p className="text-sm">
        {lookup.address ? (
          <>
            <span className="font-mono">{lookup.address}</span> is announced as <span className="font-mono font-medium">{lookup.prefix}</span>
          </>
        ) : (
          <>
            <span className="font-mono font-medium">{lookup.prefix}</span> is announced
          </>
        )}
        {lookup.announcedBy.length > 0 && <> by {lookup.announcedBy.map(each => network(each.asn, each.name)).join(', ')}</>}.{' '}
        {lookup.watched ? <span className="text-signal-moderate">It is watched already.</span> : 'That is what will be watched.'}
      </p>
      <RelatedList title="It is part of" items={lookup.within} />
      <RelatedList title="Announced inside it" items={lookup.inside} />
    </div>
  )
}
