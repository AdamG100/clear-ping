'use client'

import { Suspense, use, useMemo, useState } from 'react'
import { Download, FileDown, Share2 } from 'lucide-react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import { FileDropzone } from '@/components/arc/file-dropzone/file-dropzone'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/arc/tabs/tabs'
import { Textarea } from '@/components/arc/textarea/textarea'
import { useToast } from '@/components/notifications'
import { buildSidebarLayout, groupsInOrder } from '@/lib/targets/sidebar-layout'
import { definitionOf, measurementKey } from '@/lib/targets/definition'
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_SHARED_TARGETS,
  decodeImport,
  encodeShare,
  exportTargets,
  shareLinkFor,
  type ShareDecoding,
} from '@/lib/targets/share'
import { CopyField } from '../settings/mcp-setup'
import { TargetChecklist, type ChecklistTarget } from './target-checklist'
import type { GroupOrder, Target, TargetDefinition } from '@/types/probe'

/**
 * Sending targets to another ClearPing, and taking in the ones it sent.
 *
 * Both ends of the same thing, so they share a dialog: whoever is shown how to
 * make a link has also been shown where the other person will paste it.
 *
 * A link or a file. The link is the list itself, so it needs no connection
 * between the two ClearPings, but it has to be pasted somewhere; a file can be
 * kept as a backup, or sent where a link cannot be.
 */

type Tab = 'share' | 'import'

const TABS: { value: Tab; label: string }[] = [
  { value: 'share', label: 'Share' },
  { value: 'import', label: 'Import' },
]

const HINT = 'text-xs leading-relaxed text-muted-foreground'
const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

function plural(count: number): string {
  return `${count} target${count === 1 ? '' : 's'}`
}

// ─── Share ──────────────────────────────────────────────────────────────────

function SharePanel({ targets, groupOrders }: { targets: Target[]; groupOrders: GroupOrder[] }) {
  const { reportError } = useToast()
  const [selected, setSelected] = useState(() => new Set(targets.map(target => target.id)))
  const [link, setLink] = useState<string | null>(null)

  if (targets.length === 0) {
    return <p className={HINT}>There are no targets to share yet. Add one from the sidebar first.</p>
  }

  const tooMany = selected.size > MAX_SHARED_TARGETS

  /** The ticked targets in the order the sidebar lists them, which is the order they arrive in. */
  const chosen = () => {
    const layout = buildSidebarLayout(targets, groupOrders)
    const byId = new Map(targets.map(target => [target.id, target]))
    return groupsInOrder(layout)
      .flatMap(group => layout.items[group])
      .filter(id => selected.has(id))
      .map(id => byId.get(id))
      .filter((target): target is Target => !!target)
      .map(definitionOf)
  }

  const downloadFile = () => {
    const { fileName, text } = exportTargets(chosen())
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    // After the browser has taken the download.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const createLink = async () => {
    try {
      const code = await encodeShare(chosen())
      setLink(shareLinkFor(window.location.origin, code))
    } catch (error) {
      reportError('Could not create the share link', error)
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
        <div className="space-y-2">
          <CopyField id="share-link" label={`Share link for ${plural(selected.size)}`} value={link} />
          <p className={HINT}>
            Send it to someone who runs ClearPing. They open this dialog on theirs, choose Import and paste it in.
            Opened in a browser, the link brings up the import on this ClearPing.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col gap-2">
            <Button type="button" onClick={createLink} disabled={selected.size === 0 || tooMany}>
              <Share2 {...ICON} />
              {selected.size === 0 ? 'Tick the targets to share' : `Create a share link for ${plural(selected.size)}`}
            </Button>
            <Button type="button" variant="secondary" onClick={downloadFile} disabled={selected.size === 0 || tooMany}>
              <FileDown {...ICON} />
              Download as a file
            </Button>
          </div>
          {tooMany ? (
            <Alert tone="warning" title={`At most ${MAX_SHARED_TARGETS} targets`}>
              A link or file holds at most {MAX_SHARED_TARGETS} targets. Untick some, or share them in two.
            </Alert>
          ) : (
            <p className={HINT}>
              The link, or the file, is the list itself: each target&apos;s name, address, probe settings, interval and
              group. Nothing recorded for them goes with it, and no alerts. Neither needs the two ClearPings to reach
              each other: a link is pasted into the other one, a file chosen there under Import.
            </p>
          )}
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
    return <Alert tone="danger" title="This cannot be imported">{decoded.error}</Alert>
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
        <p className="text-sm text-muted-foreground">
          It holds {plural(decoded.targets.length)}.
          {alreadyHere > 0 && ` ${alreadyHere} of them ${alreadyHere === 1 ? 'is' : 'are'} monitored here already, and start unticked.`}
          {decoded.skipped > 0 && ` ${decoded.skipped} more could not be read and ${decoded.skipped === 1 ? 'was' : 'were'} left out.`}
        </p>
        <TargetChecklist targets={offered} groupOrders={[]} selected={selected} onChange={setSelected} />
      </div>

      <div className="space-y-2">
        <Button type="button" className="w-full" onClick={importTicked} loading={importing} disabled={selected.size === 0}>
          <Download {...ICON} />
          {selected.size === 0 ? 'Tick the targets to import' : `Import ${plural(selected.size)}`}
        </Button>
        <p className={HINT}>
          Each is added as a new target, in the group it was shared from, and probing starts straight away. Nothing
          already here is changed.
        </p>
      </div>
    </div>
  )
}

function ImportPanel({ initialText, existing, onImport }: ImportProps & { initialText: string }) {
  const [text, setText] = useState(initialText)
  // A file chosen takes the place of anything pasted, until it is taken off.
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const pasted = text.trim()
  const source = file?.text ?? pasted
  // Read as it is pasted or chosen. Made here, not in the preview that waits on
  // it: a component that is still waiting keeps nothing, and would start it again.
  const decoding = useMemo(() => (source ? decodeImport(source) : null), [source])

  const chooseFile = async (chosen: File | undefined) => {
    setFileError(null)
    if (!chosen) {
      setFile(null)
      return
    }
    if (chosen.size > MAX_IMPORT_FILE_BYTES) {
      setFileError(`${chosen.name} is too big to be an export of targets.`)
      return
    }
    setFile({ name: chosen.name, text: await chosen.text() })
  }

  return (
    <div className="space-y-4">
      {!file && (
        <Textarea
          label="Share link"
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Paste a ClearPing share link"
          description={
            decoding
              ? undefined
              : "A link made under Share, on this ClearPing or on someone else's. You are shown what is in it, and choose what to add, before anything is added."
          }
          value={text}
          onChange={event => setText(event.target.value)}
          style={{ fontFamily: 'var(--font-plex-mono), ui-monospace, monospace' }}
        />
      )}

      <FileDropzone
        label={file ? 'File' : 'Or a file'}
        description="An export downloaded under Share"
        dropLabel="Drop the file here"
        accept=".json,application/json"
        multiple={false}
        maxFiles={1}
        maxSize={MAX_IMPORT_FILE_BYTES}
        listPlacement="inside"
        onFilesChange={files => void chooseFile(files[0])}
      />
      {fileError && <Alert tone="danger" title="That file was not read">{fileError}</Alert>}

      {decoding && (
        <Suspense fallback={null}>
          {/* Keyed by what was pasted or chosen: a different list, ticked from scratch. */}
          <ImportPreview key={source} decoding={decoding} existing={existing} onImport={onImport} />
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
  /** False for an account that may only look: it can share what is here, but not add to it. */
  canImport?: boolean
}

function ShareDialogBody({ existing, groupOrders, incomingCode, onImport, canImport = true }: Omit<ShareDialogProps, 'open' | 'onOpenChange'>) {
  // Someone who followed a link came to import it, and with no targets yet
  // importing is all there is to do.
  const [chosenTab, setTab] = useState<Tab>(incomingCode || existing.length === 0 ? 'import' : 'share')
  const tab: Tab = canImport ? chosenTab : 'share'
  const tabs = canImport ? TABS : TABS.filter(option => option.value === 'share')

  // Both panels are kept while the dialog is open, and the one not on show is
  // hidden: looking at the other tab should not untick a list or lose a pasted
  // link.
  return (
    <Tabs value={tab} onValueChange={value => setTab(value as Tab)}>
      {tabs.length > 1 && (
        <TabsList aria-label="Share or import">
          {tabs.map(option => (
            <TabsTrigger key={option.value} value={option.value}>
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
      )}
      <TabsContent value="share" forceMount>
        <div hidden={tab !== 'share'} className="text-foreground">
          <SharePanel targets={existing} groupOrders={groupOrders} />
        </div>
      </TabsContent>
      {canImport && (
        <TabsContent value="import" forceMount>
          <div hidden={tab !== 'import'} className="text-foreground">
            <ImportPanel initialText={incomingCode ?? ''} existing={existing} onImport={onImport} />
          </div>
        </TabsContent>
      )}
    </Tabs>
  )
}

export function ShareDialog({ open, onOpenChange, ...body }: ShareDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Share targets"
        description="Send the targets you monitor to someone else's ClearPing as a link or a file, or add the ones they sent you."
      >
        {/* Inside the dialog's content, which is unmounted on close, so every
            opening starts with everything ticked and nothing pasted. */}
        <ShareDialogBody {...body} />
      </DialogContent>
    </Dialog>
  )
}
