'use client'

import { useState, type FormEvent } from 'react'
import { Button } from '@/components/arc/button/button'
import { Checkbox } from '@/components/arc/checkbox/checkbox'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { Input } from '@/components/arc/input/input'
import { useToast } from '@/components/notifications'

/**
 * Your own network's AS numbers: whose routes and traffic "From your network"
 * shows on each prefix's page. Usually one, your ISP's or your own.
 */

function parse(text: string): number[] | null {
  const words = text.split(/[\s,]+/).filter(Boolean)
  const asns = words.map(word => Number(word.replace(/^as/i, '')))
  return asns.every(asn => Number.isInteger(asn) && asn > 0 && asn <= 4_294_967_295) ? asns : null
}

export function NetworkDialog({
  open,
  onOpenChange,
  asns,
  agents,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  asns: number[]
  /** Every probe agent, and whether Routing uses it. */
  agents: { id: string; name: string; included: boolean }[]
  onSaved: () => void
}) {
  const { notify, reportError } = useToast()
  const [text, setText] = useState(asns.map(asn => `AS${asn}`).join(', '))
  const [left, setLeft] = useState<string[]>(agents.filter(agent => !agent.included).map(agent => agent.id))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const change = (next: boolean) => {
    if (next) {
      setText(asns.map(asn => `AS${asn}`).join(', '))
      setLeft(agents.filter(agent => !agent.included).map(agent => agent.id))
    }
    setProblem(null)
    onOpenChange(next)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const parsed = parse(text)
    if (!parsed) {
      setProblem('Give AS numbers, such as AS64500, separated by commas')
      return
    }
    setBusy(true)
    try {
      const put = (payload: object) =>
        fetch('/api/bgp', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      let response = await put({ homeAsns: parsed })
      let body = await response.json().catch(() => null)
      if (response.ok) {
        response = await put({ excludedAgents: left })
        body = await response.json().catch(() => null)
      }
      if (!response.ok) {
        setProblem(body?.error ?? `Server responded ${response.status}`)
        return
      }
      notify({
        tone: 'success',
        title: parsed.length > 0 ? `Your network is ${parsed.map(asn => `AS${asn}`).join(', ')}` : 'Your network is forgotten',
      })
      onSaved()
      onOpenChange(false)
    } catch (error) {
      reportError('Could not set your network', error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        title="Your network"
        description={`The AS number of your ISP, or your own${agents.length > 0 ? ', and the probe agents to use' : ''}. Each prefix's page then shows how ${agents.length > 0 ? 'they reach' : 'your network reaches'} it.`}
      >
        <form onSubmit={submit} noValidate className="space-y-4 text-foreground">
          <Input
            label="AS numbers"
            placeholder="AS64500"
            value={text}
            onChange={event => setText(event.target.value)}
            error={problem ?? undefined}
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            Its routes show where it shares them with RIPE RIS&apos;s collectors, as many ISPs do. The path your traffic
            takes is traced to your targets inside each prefix, from this server and your probe agents. Leave it empty to
            forget it.
          </p>
          {agents.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Probe agents in Routing</legend>
              <p className="text-xs text-muted-foreground">
                Each one is traced from and its network drawn in its own colour on the paths. All are in, and any added later
                join them; untick one to leave it out.
              </p>
              {agents.map(agent => (
                <Checkbox
                  key={agent.id}
                  label={agent.name}
                  checked={!left.includes(agent.id)}
                  onCheckedChange={checked => setLeft(current => (checked === true ? current.filter(id => id !== agent.id) : [...current, agent.id]))}
                />
              ))}
            </fieldset>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => change(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
