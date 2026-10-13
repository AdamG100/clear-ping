'use client'

import { Suspense, use, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { buildSidebarLayout, groupsInOrder } from '@/lib/sidebar-layout'
import { definitionOf, measurementKey } from '@/lib/target-definition'
import {
  MAX_SHARED_TARGETS,
  decodeShare,
  encodeShare,
  shareLinkFor,
  type ShareDecoding,
} from '@/lib/target-share'
import { TargetChecklist, type ChecklistTarget } from './target-checklist'
import type { GroupOrder, Target, TargetDefinition } from '@/types/probe'

/**
 * Sending targets to another ClearPing, and taking in the ones it sent.
 *
 * Both ends of the same thing, so they share a dialog: whoever is shown how to
 * make a link has also been shown where the other person will paste it.
 */

type Tab = 'share' | 'import'

const TABS: { value: Tab; label: string; icon: typeof Share2 }[] = [
  { value: 'share', label: 'Share', icon: Share2 },
  { value: 'import', label: 'Import', icon: Download },
]

const FIELD_LABEL = 'text-xs text-card-foreground'
const HINT = 'text-[11px] leading-relaxed text-muted-foreground'

function plural(count: number): string {
  return `${count} target${count === 1 ? '' : 's'}`
}

// ─── Share ──────────────────────────────────────────────────────────────────

function SharePanel({ targets, groupOrders }: { targets: Target[]; groupOrders: GroupOrder[] }) {
  const { reportError } = useToast()
  const [selected, setSelected] = useState(() => new Set(targets.map(target => target.id)))
  const [link, setLink] = useState<string | null>(null)
  // `manual` once copying has been tried and the browser would not do it.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const linkRef = useRef<HTMLInputElement>(null)

  if (targets.length === 0) {
    return <p className="text-xs text-muted-foreground">There are no targets to share yet. Add one from the sidebar first.</p>
  }

  const tooMany = selected.size > MAX_SHARED_TARGETS

  const createLink = async () => {
    // In the order the sidebar lists them, which is the order they arrive in.
    const layout = buildSidebarLayout(targets, groupOrders)
    const byId = new Map(targets.map(target => [target.id, target]))
    const chosen = groupsInOrder(layout)
      .flatMap(group => layout.items[group])
      .filter(id => selected.has(id))
      .map(id => byId.get(id))
      .filter((target): target is Target => !!target)

    try {
      const code = await encodeShare(chosen.map(definitionOf))
      setLink(shareLinkFor(window.location.origin, code))
      setCopyState('idle')
    } catch (error) {
      reportError('Could not create the share link', error)
    }
  }

  const copyLink = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopyState('copied')
    } catch {
      // A page served over plain http, from anywhere but this machine, is not
      // given a clipboard. The link is left selected for copying by hand.
      linkRef.current?.select()
      setCopyState('manual')
    }
  }

  return (
    <div className="space-y-4">
      <TargetChecklist
        targets={targets}
        groupOrders={groupOrders}
        selected={selected}
        // A link is the list it was made from. Change the list and it is no
        // longer the link for it, so it goes rather than be sent by mistake.
        onChange={next => { setSelected(next); setLink(null) }}
      />

      {link ? (
        <div className="space-y-1.5">
          <Label htmlFor="share-link" className={FIELD_LABEL}>Share link for {plural(selected.size)}</Label>
          <div className="flex gap-2">
            <Input
              id="share-link"
              ref={linkRef}
              readOnly
              value={link}
              onFocus={event => event.target.select()}
              aria-describedby="share-link-hint"
              className="h-9 min-w-0 flex-1 border-border bg-input font-mono text-xs text-foreground md:text-xs"
            />
            <Button type="button" onClick={copyLink} className="shrink-0">
              {copyState === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copyState === 'copied' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p id="share-link-hint" className={HINT} role={copyState === 'manual' ? 'alert' : undefined}>
            {copyState === 'manual' ? (
              <>This browser would not copy it. It is selected: copy it with Ctrl+C, or ⌘C on a Mac.</>
            ) : (
              <>
                Send it to someone who runs ClearPing. They open this dialog on theirs, choose Import and paste it
                in. Opened in a browser as it is, it brings the import up on this ClearPing.
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Button type="button" className="w-full" onClick={createLink} disabled={selected.size === 0 || tooMany}>
            <Share2 className="h-4 w-4" />
            {selected.size === 0 ? 'Tick the targets to share' : `Create a share link for ${plural(selected.size)}`}
          </Button>
          <p className={cn(HINT, tooMany && 'text-destructive')}>
            {tooMany ? (
              <>A link holds at most {MAX_SHARED_TARGETS} targets. Untick some, or share them as two links.</>
            ) : (
              <>
                The link is the list itself: each target&apos;s name, address, probe settings, interval and group.
                Nothing recorded for them goes with it, and no alerts.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Import ─────────────────────────────────────────────────────────────────

interface ImportProps {
  /** The targets already here, to say which of the incoming ones are not new. */
  existing: Target[]
  /** Add the targets. Resolves to whether they were added. */
  onImport: (targets: TargetDefinition[]) => Promise<boolean>
}

/** What a pasted link holds, once it has been read: the targets to pick from, or why not. */
function ImportPreview({ decoding, existing, onImport }: ImportProps & { decoding: Promise<ShareDecoding> }) {
  const decoded = use(decoding)
  const [importing, setImporting] = useState(false)

  const monitored = useMemo(() => new Set(existing.map(measurementKey)), [existing])

  // A target in a link has no id yet, so in the list it goes by its place.
  const offered = useMemo<ChecklistTarget[]>(() => {
    if (!decoded.ok) return []
    return decoded.targets.map((target, index) => ({
      id: String(index),
      name: target.name,
      host: target.host,
      group: target.group,
      sortOrder: index,
      note: monitored.has(measurementKey(target)) ? 'Already here' : undefined,
    }))
  }, [decoded, monitored])

  // Ticked to begin with, apart from the ones that would only be a second
  // copy of something already monitored. Those can still be ticked by hand.
  const [selected, setSelected] = useState(() => new Set(offered.filter(target => !target.note).map(target => target.id)))

  if (!decoded.ok) {
    return <p className="text-xs text-destructive" role="alert">{decoded.error}</p>
  }

  const alreadyHere = offered.filter(target => target.note).length

  const importTicked = async () => {
    setImporting(true)
    const added = await onImport(decoded.targets.filter((_, index) => selected.has(String(index))))
    // Added, the dialog closes and takes this with it.
    if (!added) setImporting(false)
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          The link holds {plural(decoded.targets.length)}.
          {alreadyHere > 0 && ` ${alreadyHere} of them ${alreadyHere === 1 ? 'is' : 'are'} monitored here already, and start unticked.`}
          {decoded.skipped > 0 && ` ${decoded.skipped} more could not be read and ${decoded.skipped === 1 ? 'was' : 'were'} left out.`}
        </p>
        <TargetChecklist targets={offered} groupOrders={[]} selected={selected} onChange={setSelected} />
      </div>

      <div className="space-y-2">
        <Button type="button" className="w-full" onClick={importTicked} disabled={importing || selected.size === 0}>
          <Download className="h-4 w-4" />
          {importing ? 'Importing…' : selected.size === 0 ? 'Tick the targets to import' : `Import ${plural(selected.size)}`}
        </Button>
        <p className={HINT}>
          Each is added as a new target, in the group it was shared from, and probing starts straight away.
          Nothing already here is changed.
        </p>
      </div>
    </div>
  )
}

function ImportPanel({ initialText, existing, onImport }: ImportProps & { initialText: string }) {
  const [text, setText] = useState(initialText)
  const pasted = text.trim()
  // Read as it is pasted. Made here, not in the preview that waits on it: a
  // component that is still waiting keeps nothing, and would start it again.
  const decoding = useMemo(() => (pasted ? decodeShare(pasted) : null), [pasted])

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="import-link" className={FIELD_LABEL}>Share link</Label>
        <textarea
          id="import-link"
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Paste a ClearPing share link"
          value={text}
          onChange={event => setText(event.target.value)}
          aria-describedby={decoding ? undefined : 'import-link-hint'}
          className={cn(
            'w-full min-w-0 resize-y break-all rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-foreground',
            'placeholder:text-muted-foreground outline-none transition-[color,box-shadow]',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
          )}
        />
        {!decoding && (
          <p id="import-link-hint" className={HINT}>
            A link made under Share, on this ClearPing or on someone else&apos;s. You are shown what is in it,
            and choose what to add, before anything is added.
          </p>
        )}
      </div>

      {decoding && (
        <Suspense fallback={null}>
          {/* Keyed by what was pasted: a different link is a different list,
              ticked from scratch. */}
          <ImportPreview key={pasted} decoding={decoding} existing={existing} onImport={onImport} />
        </Suspense>
      )}
    </div>
  )
}

// ─── The dialog ─────────────────────────────────────────────────────────────

interface ShareDialogProps extends ImportProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupOrders: GroupOrder[]
  /** The share code the page was opened with, if it was opened from a share link. */
  incomingCode: string | null
}

function ShareDialogBody({ existing, groupOrders, incomingCode, onImport }: Omit<ShareDialogProps, 'open' | 'onOpenChange'>) {
  // Someone who followed a link came to import it, and with no targets yet
  // importing is all there is to do.
  const [tab, setTab] = useState<Tab>(incomingCode || existing.length === 0 ? 'import' : 'share')

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-card-foreground flex items-center gap-2">
          <div className="h-8 w-8 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
            <Share2 className="h-4 w-4 text-primary" />
          </div>
          Share targets
        </DialogTitle>
        <DialogDescription className="text-muted-foreground">
          Send the targets you monitor to someone else&apos;s ClearPing as a link, or add the ones they sent you.
        </DialogDescription>
      </DialogHeader>

      <div
        className="grid grid-cols-2 gap-0.5 rounded-lg border border-border bg-muted/30 p-0.5"
        role="tablist"
        aria-label="Share or import"
      >
        {TABS.map(option => (
          <button
            key={option.value}
            type="button"
            role="tab"
            id={`share-tab-${option.value}`}
            aria-selected={tab === option.value}
            aria-controls={`share-panel-${option.value}`}
            onClick={() => setTab(option.value)}
            className={cn(
              'flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs outline-none transition-colors touch:py-2.5',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50',
              tab === option.value
                ? 'bg-primary font-medium text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            <option.icon className="h-3.5 w-3.5" />
            {option.label}
          </button>
        ))}
      </div>

      {/* Both are kept while the dialog is open, and the one not on show is
          hidden: looking at the other tab should not untick a list or lose a
          pasted link. */}
      <div role="tabpanel" id="share-panel-share" aria-labelledby="share-tab-share" hidden={tab !== 'share'}>
        <SharePanel targets={existing} groupOrders={groupOrders} />
      </div>
      <div role="tabpanel" id="share-panel-import" aria-labelledby="share-tab-import" hidden={tab !== 'import'}>
        <ImportPanel initialText={incomingCode ?? ''} existing={existing} onImport={onImport} />
      </div>
    </>
  )
}

export function ShareDialog({ open, onOpenChange, ...body }: ShareDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-xl" suppressHydrationWarning>
        {/* Inside the dialog's content, which is unmounted on close, so every
            opening starts with everything ticked and nothing pasted. */}
        <ShareDialogBody {...body} />
      </DialogContent>
    </Dialog>
  )
}
