"use client"

import { useEffect, useState } from "react"
import { Eye, Route } from "lucide-react"
import { Alert } from "@/components/arc/alert/alert"
import { Button } from "@/components/arc/button/button"
import { lastAnsweringHop } from "@/lib/traceroute/parse"
import type { Target, TracerouteHop } from "@/types/probe"
import { Masked } from '../privacy/masked'

/**
 * Says why a closed-port check that has never had an answer is shown grey:
 * the server, or the firewall in front of it, drops packets to closed ports
 * without a word, as a cloud firewall such as Google Cloud's does. The check
 * cannot measure it, and says nothing about whether the game is up.
 *
 * What can be measured is the way to it, as far as it answers. The furthest
 * hop that answered in the latest trace (usually where the traffic enters the
 * host's network) is offered as a ping target to watch in its place.
 */

type Found =
  | { state: "loading" }
  | { state: "none" }
  | { state: "silent" }
  | { state: "found"; hop: TracerouteHop; ofHops: number }

/** The furthest hop that answered in a target's latest trace, if it has one. */
async function furthestAnswering(targetId: string): Promise<Found> {
  try {
    const response = await fetch(`/api/targets/${targetId}/traceroute?limit=1`)
    if (!response.ok) return { state: "none" }
    const { traceroutes } = (await response.json()) as { traceroutes: { address: string; hops: TracerouteHop[] }[] }
    const latest = traceroutes[0]
    if (!latest) return { state: "none" }
    const hop = lastAnsweringHop(latest.hops, latest.address)
    return hop ? { state: "found", hop, ofHops: latest.hops.length } : { state: "silent" }
  } catch {
    return { state: "none" }
  }
}

export function SilentServerNote({
  target,
  probes,
  targets,
  readOnly = false,
  onWatch,
  onShow,
}: {
  target: Pick<Target, "id" | "name">
  probes: number
  /** Every target, to tell whether the hop is watched already. */
  targets: Pick<Target, "id" | "name" | "host" | "probeType">[]
  readOnly?: boolean
  /** Adds the hop as a ping target. */
  onWatch: (address: string) => Promise<void>
  /** Opens a target. */
  onShow: (id: string) => void
}) {
  const [found, setFound] = useState<Found>({ state: "loading" })
  const [busy, setBusy] = useState<"tracing" | "adding" | null>(null)

  useEffect(() => {
    let current = true
    void furthestAnswering(target.id).then(next => { if (current) setFound(next) })
    return () => { current = false }
  }, [target.id])

  const trace = async () => {
    setBusy("tracing")
    try {
      await fetch(`/api/targets/${target.id}/traceroute`, { method: "POST" })
      setFound(await furthestAnswering(target.id))
    } finally {
      setBusy(null)
    }
  }

  const watch = async (address: string) => {
    setBusy("adding")
    try {
      await onWatch(address)
    } finally {
      setBusy(null)
    }
  }

  const watched = found.state === "found"
    ? targets.find(other => other.host === found.hop.address && other.probeType === "ping")
    : undefined

  return (
    <Alert tone="info" title="This server can't be measured with the closed-port check">
      {/* Spans, not paragraphs: the alert sets what it is given in a <p> of its own. */}
      <span className="block space-y-3">
        <span className="block">
          It has not answered once since it was added ({probes.toLocaleString()} probes in this period, none
          answered). The server, or a firewall in front of it, drops packets to closed ports without replying, as
          Google Cloud&apos;s firewall does. That says nothing about whether the game is up, so it is shown grey,
          not as down, and raises no alerts until it answers.
        </span>

        {found.state === "found" && (
          <span className="block">
            What can be watched is the way to it.{" "}
            <span className="font-mono text-foreground"><Masked value={found.hop.hostname || found.hop.address!} /></span>
            {found.hop.hostname && <span className="font-mono"> (<Masked value={found.hop.address!} />)</span>}, hop {found.hop.hop} of{" "}
            {found.ofHops} in the latest trace, is the furthest point on the way that answers: usually where your
            traffic enters the host&apos;s network. Pinging it shows whether lag starts on your side of it.
          </span>
        )}
        {found.state === "none" && (
          <span className="block">
            What can be watched is the way to it. Trace the route to find the furthest point on the way that
            answers, and watch that instead.
          </span>
        )}
        {found.state === "silent" && (
          <span className="block">Nothing on the way answered the latest trace either, so there is no point on it to watch.</span>
        )}

        <span className="flex flex-wrap gap-2">
          {found.state === "found" && !readOnly && !watched && (
            <Button size="sm" onClick={() => void watch(found.hop.address!)} disabled={busy !== null}>
              <Eye size={14} strokeWidth={1.75} aria-hidden="true" />
              {busy === "adding" ? "Adding…" : `Watch ${found.hop.address} instead`}
            </Button>
          )}
          {watched && (
            <Button size="sm" variant="secondary" onClick={() => onShow(watched.id)}>
              <Eye size={14} strokeWidth={1.75} aria-hidden="true" />
              Watched as {watched.name}
            </Button>
          )}
          {found.state === "none" && !readOnly && (
            <Button size="sm" onClick={() => void trace()} disabled={busy !== null}>
              <Route size={14} strokeWidth={1.75} aria-hidden="true" />
              {busy === "tracing" ? "Tracing… (up to a minute)" : "Trace the route now"}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => document.getElementById("route")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            <Route size={14} strokeWidth={1.75} aria-hidden="true" />
            Go to traceroute
          </Button>
        </span>
      </span>
    </Alert>
  )
}
