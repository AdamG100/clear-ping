'use client'

import { useMemo, useState } from 'react'
import { BGP_DIRECT, BGP_REGIONS, type BgpPeerRoute, type BgpRegion, type BgpUpstreamShare } from '@/types/bgp'
import { countryName } from '@/lib/bgp/countries'
import { hops, upstreamOf } from '@/lib/bgp/path'
import { cn } from '@/lib/utils'
import { asLabel, whoseLabel } from './state'

/**
 * The way the world reaches the prefix, as one picture: the regions the
 * collectors' peers are in (or the countries, once a region is chosen), the networks their peers hear it from, the upstreams it
 * comes through, and the network announcing it. A band is as thick as the
 * peers that take it and has the colour of its upstream, so a move from one
 * upstream to another shows as a band changing colour across the regions.
 */

const WIDTH = 1000
const NODE_WIDTH = 190
const NODE_HEIGHT = 30
const ROW = 42
const TOP = 28
const MOST_NEIGHBOURS = 9
const MOST_UPSTREAMS = 7
const OTHER = -1

interface Node {
  id: string
  column: number
  label: string
  detail: string
  peers: number
  /** For an upstream: its colour, and whether it is a usual one. */
  color?: string
  unusual?: boolean
}

interface Edge {
  from: string
  to: string
  peers: number
  upstream: number
}

/**
 * The line of one of yours: "Your ISP" the foreground colour, each probe agent
 * a colour and a dash of its own, taken from the far end of the chart palette
 * so they are not the upstream bands' first colours.
 */
function ownerLine(index: number): { color: string; dash: string } {
  const dashes = ['6 4', '2 4', '10 3 2 3', '1 3']
  return {
    color: index === 0 ? 'var(--foreground)' : `var(--line-${16 - ((index - 1) % 8)})`,
    dash: dashes[index % dashes.length],
  }
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function asNode(asn: number, column: number, peers: number, names: Record<number, string>): Node {
  if (asn === OTHER) return { id: `${column}:${asn}`, column, label: 'Other networks', detail: '', peers }
  // In the upstream column: the peers that connect to the origin themselves.
  if (asn === BGP_DIRECT) return { id: `${column}:${asn}`, column, label: 'Directly connected', detail: '', peers }
  return { id: `${column}:${asn}`, column, label: `AS${asn}`, detail: names[asn] ?? '', peers }
}

/** Short enough to sit in a node beside its count; the full name is in the tooltip. */
const REGION_SHORT: Record<BgpRegion, string> = {
  africa: 'Africa',
  europe: 'Europe & ME',
  'north-america': 'North America',
  'latin-america': 'Latin America',
  'asia-pacific': 'Asia Pacific',
}

export function PathGraph({
  peers,
  upstreams,
  names,
  colors,
  selected,
  onSelect,
  onPlace,
  mine = {},
  byCountry = false,
}: {
  peers: BgpPeerRoute[]
  upstreams: BgpUpstreamShare[]
  names: Record<number, string>
  colors: Map<number, string>
  /** The upstream chosen on the page: its routes stay lit until another is hovered. */
  selected: number | null
  onSelect: (asn: number | null) => void
  /** Narrow the page to a region, or to a country once one is chosen: what a node in the first column does. */
  onPlace?: (place: string) => void
  /** Your networks, and whose each is: their routes are drawn over the bands. */
  mine?: Record<number, string>
  /** Start from the peers' countries rather than their regions: for a region chosen. */
  byCountry?: boolean
}) {
  // What is lit: an upstream's routes, all the way through, or the bands into
  // and out of one node. Hovering shows it; choosing an upstream, or pinning a
  // network the peers hear it from, keeps it.
  const [hovered, setHovered] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const litNode = hovered ?? pinned
  const litUpstream = litNode?.startsWith('2:') ? Number(litNode.slice(2)) : litNode === null ? selected : null
  const litOtherNode = litNode && !litNode.startsWith('2:') ? litNode : null

  const graph = useMemo(() => {
    // Each peer once: the first route listed for it is the one that counts.
    const seen = new Set<string>()
    const flows: { place: string; label: string; neighbour: number; upstream: number; origin: number; whose: string | null }[] = []
    for (const each of peers) {
      const key = `${each.collector}|${each.peer}`
      if (!each.route || seen.has(key)) continue
      seen.add(key)
      const path = hops(each.route.path)
      const upstream = upstreamOf(path)
      if (upstream === null) continue
      flows.push({
        place: byCountry ? each.country : each.region,
        label: byCountry ? countryName(each.country) : REGION_SHORT[each.region],
        // The network before the upstream; for a peer that reaches the origin
        // directly, the peer itself. Every route then passes through a node in
        // each column: one that skipped "Heard from" was drawn across it,
        // joined to nothing there.
        neighbour: path[Math.max(0, path.length - 3)],
        upstream,
        origin: path[path.length - 1],
        whose: each.peerAsn in mine ? whoseLabel(mine[each.peerAsn]) : null,
      })
    }

    const count = <K,>(values: K[]) => {
      const counts = new Map<K, number>()
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
      return [...counts].sort((a, b) => b[1] - a[1])
    }
    const keptNeighbours = new Set(count(flows.map(flow => flow.neighbour)).slice(0, MOST_NEIGHBOURS).map(([asn]) => asn))
    const keptUpstreams = new Set(count(flows.map(flow => flow.upstream)).slice(0, MOST_UPSTREAMS).map(([asn]) => asn))
    const neighbourOf = (flow: (typeof flows)[number]) => (keptNeighbours.has(flow.neighbour) ? flow.neighbour : OTHER)
    const upstreamNode = (asn: number) => (keptUpstreams.has(asn) ? asn : OTHER)

    const nodes = new Map<string, Node>()
    const add = (node: Node) => {
      const held = nodes.get(node.id)
      if (held) held.peers += node.peers
      else nodes.set(node.id, node)
    }
    const edges = new Map<string, Edge>()
    // Your networks' routes: the links and the nodes they pass through, and whose they are.
    const myLinks = new Map<string, Set<string>>()
    const myNodes = new Map<string, Set<string>>()
    let whose: string | null = null
    const link = (from: string, to: string, upstream: number) => {
      const key = `${from}>${to}>${upstream}`
      const held = edges.get(key)
      if (held) held.peers++
      else edges.set(key, { from, to, peers: 1, upstream })
      if (whose) {
        myLinks.set(`${from}>${to}`, new Set([...(myLinks.get(`${from}>${to}`) ?? []), whose]))
        for (const id of [from, to]) myNodes.set(id, new Set([...(myNodes.get(id) ?? []), whose]))
      }
    }

    for (const flow of flows) {
      whose = flow.whose
      const region = `0:${flow.place}`
      add({ id: region, column: 0, label: flow.label, detail: '', peers: 1 })
      const neighbour = neighbourOf(flow)
      const up = upstreamNode(flow.upstream)
      const upstreamId = `2:${up}`
      add({ ...asNode(up, 2, 1, names), color: up === OTHER ? 'var(--signal-none)' : colors.get(up), unusual: upstreams.find(each => each.asn === up)?.expected === false })
      add(asNode(flow.origin, 3, 1, names))
      const neighbourId = `1:${neighbour}`
      add(asNode(neighbour, 1, 1, names))
      link(region, neighbourId, flow.upstream)
      link(neighbourId, upstreamId, flow.upstream)
      link(upstreamId, `3:${flow.origin}`, flow.upstream)
    }

    // Regions in their usual order; countries, and every other column, biggest first.
    const columns = [0, 1, 2, 3].map(column =>
      [...nodes.values()]
        .filter(node => node.column === column)
        .sort((a, b) =>
          column === 0 && !byCountry
            ? BGP_REGIONS.indexOf(a.id.slice(2) as BgpRegion) - BGP_REGIONS.indexOf(b.id.slice(2) as BgpRegion)
            : b.peers - a.peers
        )
    )
    for (const node of [...columns[0], ...columns[1].filter(each => each.id.endsWith(`:${OTHER}`))]) {
      node.detail = String(node.peers)
    }
    const rows = Math.max(1, ...columns.map(column => column.length))
    const height = TOP * 2 + rows * ROW
    const position = new Map<string, { x: number; y: number }>()
    columns.forEach((column, index) => {
      const x = (index * (WIDTH - NODE_WIDTH)) / 3
      const offset = (height - column.length * ROW) / 2
      column.forEach((node, row) => position.set(node.id, { x, y: offset + row * ROW + (ROW - NODE_HEIGHT) / 2 }))
    })
    // Everyone drawn, "Your ISP" first: each keeps a line of its own, in the order they are listed here.
    const owners = [...new Set(flows.flatMap(flow => (flow.whose ? [flow.whose] : [])))].sort(
      (a, b) => Number(b === whoseLabel('This server')) - Number(a === whoseLabel('This server')) || a.localeCompare(b)
    )
    return { nodes: [...nodes.values()], edges: [...edges.values()], position, height, flows: flows.length, myLinks, myNodes, owners }
  }, [peers, upstreams, names, colors, byCountry, mine])

  if (graph.flows === 0) {
    return <p className="text-sm text-muted-foreground">No collector peer has a route to it now, so there is no path to draw.</p>
  }

  const widest = Math.max(...graph.edges.map(edge => edge.peers))
  const thickness = (peers: number) => Math.max(1.5, Math.min(16, (peers / widest) * 16))

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${graph.height}`}
        // Drawn at about its own size: stretched across a wide pane its text
        // came out twice as large as the page's.
        className="mx-auto block h-auto w-full min-w-190 max-w-275"
        role="group"
        aria-label="How the collectors' peers reach the prefix: where they are, then the network they hear it from, then its upstream, then its origin"
      >
        {['Seen from', 'Heard from', 'Upstream', 'Origin'].map((title, column) => (
          <text
            key={title}
            x={(column * (WIDTH - NODE_WIDTH)) / 3 + 2}
            y={14}
            className="fill-muted-foreground"
            fontSize={11}
          >
            {title}
          </text>
        ))}

        {graph.edges.map(edge => {
          const from = graph.position.get(edge.from)
          const to = graph.position.get(edge.to)
          if (!from || !to) return null
          const x1 = from.x + NODE_WIDTH
          const y1 = from.y + NODE_HEIGHT / 2
          const x2 = to.x
          const y2 = to.y + NODE_HEIGHT / 2
          const bend = (x2 - x1) / 2
          const lit = litOtherNode !== null ? edge.from === litOtherNode || edge.to === litOtherNode : litUpstream === null || litUpstream === edge.upstream
          return (
            <path
              key={`${edge.from}>${edge.to}>${edge.upstream}`}
              d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke={colors.get(edge.upstream) ?? 'var(--signal-none)'}
              strokeWidth={thickness(edge.peers)}
              strokeLinecap="round"
              opacity={lit ? (litNode !== null || selected !== null ? 0.75 : 0.5) : 0.07}
              className="cursor-pointer transition-opacity duration-150"
              // A band is its upstream's: choosing it chooses that.
              onClick={() => onSelect(selected === edge.upstream ? null : edge.upstream)}
            >
              <title>{`${edge.peers} peer${edge.peers === 1 ? '' : 's'}: choose to follow its upstream`}</title>
            </path>
          )
        })}

        {[...graph.myLinks].flatMap(([key, whoseLinks]) => {
          const [fromId, toId] = key.split('>')
          const from = graph.position.get(fromId)
          const to = graph.position.get(toId)
          if (!from || !to) return []
          const x1 = from.x + NODE_WIDTH
          const y1 = from.y + NODE_HEIGHT / 2
          const x2 = to.x
          const y2 = to.y + NODE_HEIGHT / 2
          const bend = (x2 - x1) / 2
          // Where several share a link, each is a little to one side of the others.
          const sharing = graph.owners.filter(owner => whoseLinks.has(owner))
          return sharing.map((owner, index) => {
            const style = ownerLine(graph.owners.indexOf(owner))
            const shift = (index - (sharing.length - 1) / 2) * 3.5
            return (
              <path
                key={`mine:${key}:${owner}`}
                d={`M ${x1} ${y1 + shift} C ${x1 + bend} ${y1 + shift}, ${x2 - bend} ${y2 + shift}, ${x2} ${y2 + shift}`}
                fill="none"
                stroke={style.color}
                strokeWidth={2}
                strokeDasharray={style.dash}
                strokeLinecap="round"
                opacity={0.95}
                pointerEvents="none"
              />
            )
          })
        })}

        {graph.nodes.map(node => {
          const at = graph.position.get(node.id)
          if (!at) return null
          const other = node.id.endsWith(`:${OTHER}`)
          const upstream = node.column === 2 && !other ? Number(node.id.slice(2)) : null
          // What choosing it does, if anything: an upstream narrows the page to
          // it, a place narrows it there, a network heard from lights its bands.
          const action =
            upstream !== null
              ? () => onSelect(selected === upstream ? null : upstream)
              : node.column === 0 && onPlace
                ? () => onPlace(node.id.slice(2))
                : node.column === 1 && !other
                  ? () => setPinned(current => (current === node.id ? null : node.id))
                  : null
          const chosen = (upstream !== null && selected === upstream) || pinned === node.id
          const faded = node.column === 2 && selected !== null && !chosen && litNode === null
          const what =
            upstream !== null
              ? chosen ? 'Show every upstream again' : `Narrow the page to ${node.label}`
              : node.column === 0
                ? `Narrow the page to ${node.label}`
                : chosen ? 'Stop following it' : 'Follow its routes'
          return (
            <g
              key={node.id}
              transform={`translate(${at.x} ${at.y})`}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={action ?? undefined}
              onKeyDown={event => {
                if (action && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  action()
                }
              }}
              role={action ? 'button' : undefined}
              tabIndex={action ? 0 : undefined}
              aria-pressed={action && node.column !== 0 ? chosen : undefined}
              aria-label={action ? `${node.label}${node.detail && node.detail !== String(node.peers) ? ` ${node.detail}` : ''}, ${node.peers} peers${graph.myNodes.has(node.id) ? `, among them ${[...graph.myNodes.get(node.id)!].join(' and ')}` : ''}. ${what}` : undefined}
              opacity={faded ? 0.45 : 1}
              className={cn('outline-none transition-opacity duration-150', action && 'cursor-pointer [&:focus-visible>rect]:stroke-[var(--focus-color)]')}
            >
              <rect
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={8}
                className="fill-card"
                style={chosen ? { fill: `color-mix(in oklab, ${node.color ?? 'var(--foreground)'} 16%, var(--card))` } : undefined}
                stroke={node.color ?? (chosen ? 'var(--foreground)' : 'var(--border-strong)')}
                strokeWidth={chosen ? 2.75 : hovered === node.id && action ? 2.25 : node.color ? 1.75 : 1}
                strokeDasharray={node.unusual ? '4 3' : undefined}
              />
              {node.color && <circle cx={12} cy={NODE_HEIGHT / 2} r={4} fill={node.color} />}
              <text x={node.color ? 22 : 10} y={NODE_HEIGHT / 2 + 4} fontSize={12} className={node.column === 0 || other || node.id === `2:${BGP_DIRECT}` ? 'fill-foreground' : 'fill-foreground font-mono'}>
                {node.column === 0 ? truncate(node.label, 20) : node.label}
                <tspan className="fill-muted-foreground font-sans" dx={6}>
                  {truncate(node.detail, node.color ? 17 : 19)}
                </tspan>
              </text>
              {graph.myNodes.has(node.id) && (() => {
                // Whose routes pass through here, by name: "Your ISP", or a probe agent's. A tab
                // on the node's top edge, in the gap between rows, so it never covers the name.
                const owners = [...graph.myNodes.get(node.id)!]
                const text = truncate(owners[0], 22) + (owners.length > 1 ? ` +${owners.length - 1}` : '')
                const width = Math.round(text.length * 5.3 + 12)
                return (
                  <g transform={`translate(${NODE_WIDTH - width - 8} -8)`} pointerEvents="none">
                    <rect width={width} height={15} rx={7.5} className="fill-primary stroke-card" strokeWidth={2} />
                    <text x={width / 2} y={11} fontSize={9} textAnchor="middle" className="fill-primary-foreground font-sans">
                      {text}
                    </text>
                  </g>
                )
              })()}
              <title>{`${node.label}${node.detail ? ` ${node.detail}` : ''}: ${node.peers} peer${node.peers === 1 ? '' : 's'}${node.unusual ? ', not one of its usual upstreams' : ''}${graph.myNodes.has(node.id) ? `. The route of ${[...graph.myNodes.get(node.id)!].join(' and ')} passes through here` : ''}${action ? `. ${what}` : ''}`}</title>
            </g>
          )
        })}
      </svg>
      {graph.myLinks.size > 0 && (
        <ul className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {graph.owners.map((owner, index) => {
            const style = ownerLine(index)
            const networks = Object.entries(mine)
              .filter(([, whose]) => whoseLabel(whose) === owner)
              .map(([asn]) => asLabel(Number(asn), names))
            return (
              <li key={owner} className="flex items-center gap-2">
                <svg width="28" height="6" aria-hidden="true">
                  <line x1="1" y1="3" x2="27" y2="3" stroke={style.color} strokeWidth="2" strokeDasharray={style.dash} strokeLinecap="round" />
                </svg>
                {owner}
                {networks.length > 0 ? ` (${networks.join(', ')})` : ''}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
