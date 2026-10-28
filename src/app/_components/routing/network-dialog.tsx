'use client'

import { useState, type FormEvent } from 'react'
import { Button } from '@/components/arc/button/button'
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
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  asns: number[]
  onSaved: () => void
}) {
  const { notify, reportError } = useToast()
  const [text, setText] = useState(asns.map(asn => `AS${asn}`).join(', '))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const change = (next: boolean) => {
    if (next) setText(asns.map(asn => `AS${asn}`).join(', '))
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
      const response = await fetch('/api/bgp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ homeAsns: parsed }),
      })
      const body = await response.json().catch(() => null)
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
        description="The AS number of your ISP, or your own. Each prefix's page then shows how your network reaches it."
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
