'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Bot, Check, ChevronRight, Copy } from 'lucide-react'
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
import { isLocalHost } from '@/lib/host'
import { cn } from '@/lib/utils'

/**
 * How to connect an AI assistant to this ClearPing.
 *
 * The app can be read over MCP, and nobody would know: it is an address that
 * answers to a program, with nothing on any page to say it is there. This is
 * the page that says so, with the address to give the assistant and what to
 * type for the commonest of them.
 */

const FIELD_LABEL = 'text-xs text-card-foreground'
const HINT = 'text-[11px] leading-relaxed text-muted-foreground'

/** Stands in the command where the token goes: the page is never told the token itself. */
const TOKEN_PLACEHOLDER = 'YOUR_TOKEN'

type Client = 'claude-code' | 'claude-app' | 'other'

const CLIENTS: { value: Client; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'claude-app', label: 'Claude apps' },
  { value: 'other', label: 'Another client' },
]

/**
 * The two ways into the Claude apps, which come down to where ClearPing is.
 * On your own network, only a program on your computer can reach it, and
 * Claude Desktop can start one. Out on the internet, Claude's servers can
 * reach it themselves, from any of the apps.
 */
type Reach = 'local' | 'remote'

/** Things worth asking, as they would be typed. */
const EXAMPLES = [
  'Gather the logs from the last week so I can report this to my ISP, as a PDF.',
  'Which targets had outages yesterday, and what kept working while they were down?',
  'Is my connection worse in the evenings?',
  'Is one of my DNS resolvers slower than the others?',
]

/** And one for an assistant that is allowed to change things. */
const WRITE_EXAMPLE = 'Add my router, my ISP\'s gateway and 1.1.1.1 as ping targets, in a group called Network.'

/** How long the button says it has copied before it offers to again. */
const COPIED_FOR_MS = 2000

/** Something to be copied, shown whole, with a button that copies it. */
function CopyField({ id, label, value, multiline = false }: { id: string; label: string; value: string; multiline?: boolean }) {
  // `manual` once copying has been tried and the browser would not do it.
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const keep = (element: HTMLInputElement | HTMLTextAreaElement | null) => { fieldRef.current = element }

  // "Copied" answers the press. Left there, it reads as a state the button is
  // in, and says nothing the next time it is pressed.
  useEffect(() => {
    if (state !== 'copied') return
    const back = setTimeout(() => setState('idle'), COPIED_FOR_MS)
    return () => clearTimeout(back)
  }, [state])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      // A page served over plain http, from anywhere but this machine, is not
      // given a clipboard. The text is left selected for copying by hand.
      fieldRef.current?.select()
      setState('manual')
    }
  }

  const field = 'min-w-0 flex-1 border-border bg-input font-mono text-xs text-foreground md:text-xs'

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={FIELD_LABEL}>{label}</Label>
      <div className="flex items-start gap-2">
        {multiline ? (
          <textarea
            id={id}
            ref={keep}
            readOnly
            value={value}
            rows={value.split('\n').length}
            onFocus={event => event.target.select()}
            className={cn(field, 'resize-none rounded-md border px-3 py-2 leading-relaxed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50')}
          />
        ) : (
          <Input id={id} ref={keep} readOnly value={value} onFocus={event => event.target.select()} className={cn(field, 'h-9')} />
        )}
        <Button type="button" variant="outline" onClick={copy} className="shrink-0">
          {state === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {state === 'copied' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {state === 'manual' && (
        <p className={HINT} role="alert">This browser would not copy it. It is selected: copy it with Ctrl+C, or ⌘C on a Mac.</p>
      )}
    </div>
  )
}

const FOLD_EASE = [0.22, 1, 0.36, 1] as const

/**
 * One of a pair of ways to do the same thing, folded away until it is the one
 * wanted. Both set out at once is two sets of steps to read to find which
 * applies; folded, the headings are the question and one answer is open.
 */
function Fold({
  title,
  detail,
  open,
  onToggle,
  children,
}: {
  title: string
  detail: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const id = useId()
  const reduceMotion = useReducedMotion()

  return (
    <section className="rounded-lg border border-border bg-muted/20">
      <h3>
        <button
          type="button"
          id={`${id}-heading`}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={onToggle}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none transition-colors touch:py-3.5',
            'hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
            open && 'rounded-b-none'
          )}
        >
          <motion.span
            className="flex shrink-0 text-muted-foreground"
            initial={false}
            animate={{ rotate: open ? 90 : 0 }}
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 30 }}
            aria-hidden="true"
          >
            <ChevronRight className="h-4 w-4" />
          </motion.span>
          <span className="min-w-0">
            <span className="block text-xs font-medium text-card-foreground">{title}</span>
            <span className="block text-[11px] leading-relaxed text-muted-foreground">{detail}</span>
          </span>
        </button>
      </h3>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            id={`${id}-body`}
            role="region"
            aria-labelledby={`${id}-heading`}
            // Grown as a grid row from none of its content's height to all of
            // it, which needs no measuring and so cannot be measured wrong.
            className="grid overflow-hidden"
            initial={{ gridTemplateRows: '0fr', opacity: 0 }}
            animate={{ gridTemplateRows: '1fr', opacity: 1 }}
            exit={{ gridTemplateRows: '0fr', opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.3, ease: FOLD_EASE }}
          >
            <div className="min-h-0 min-w-0">
              <div className="space-y-2 border-t border-border p-3">{children}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

function McpDialogBody() {
  const [client, setClient] = useState<Client>('claude-code')
  // Open on the way that fits the address this page was reached at. One at a
  // time: opening the other puts this one away.
  const [reach, setReach] = useState<Reach | null>(() => (isLocalHost(window.location.host) ? 'local' : 'remote'))
  const toggleReach = (which: Reach) => setReach(reach === which ? null : which)
  // Whether a token has to be sent with every request, which is also whether
  // an assistant can change anything. Not known until asked, and taken as not
  // needed if asking fails: the address is right either way.
  const [info, setInfo] = useState({ tokenRequired: false, plainHttpAllowed: false })
  const { tokenRequired } = info

  useEffect(() => {
    let current = true
    fetch('/api/mcp/info')
      .then(response => (response.ok ? response.json() : null))
      .then(told => {
        if (current && told) setInfo({ tokenRequired: !!told.tokenRequired, plainHttpAllowed: !!told.plainHttpAllowed })
      })
      .catch(() => {})
    return () => { current = false }
  }, [])

  // The address this page was opened at, which is the one that is known to work from here.
  const url = `${window.location.origin}/api/mcp`
  // A token is not taken in the clear from across the internet. Said here,
  // before it is tried, where the page itself was reached that way.
  const tokenWouldBeRefused =
    tokenRequired && !info.plainHttpAllowed && window.location.protocol !== 'https:' && !isLocalHost(window.location.host)
  const header = `Authorization: Bearer ${TOKEN_PLACEHOLDER}`

  const command = `claude mcp add --transport http clearping ${url}${tokenRequired ? ` --header "${header}"` : ''}`
  const config = JSON.stringify(
    { mcpServers: { clearping: { type: 'http', url, ...(tokenRequired ? { headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` } } : {}) } } },
    null,
    2
  )

  // Claude Desktop starts programs on the computer it runs on and talks to
  // those; it does not open an address itself. `mcp-remote` is the program
  // that stands between: started by Claude Desktop, it passes everything on to
  // the address. Being on that computer, it can reach a ClearPing that only
  // that computer's network can.
  const desktopConfig = JSON.stringify(
    {
      mcpServers: {
        clearping: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote',
            url,
            // It takes plain HTTP only where it is told the network is one to trust.
            ...(url.startsWith('http://') ? ['--allow-http'] : []),
            // No space after the colon: Claude Desktop on Windows splits an
            // argument at its spaces. The value, which has one, goes in `env`.
            ...(tokenRequired ? ['--header', 'Authorization:${AUTH_HEADER}'] : []),
          ],
          ...(tokenRequired ? { env: { AUTH_HEADER: `Bearer ${TOKEN_PLACEHOLDER}` } } : {}),
        },
      },
    },
    null,
    2
  )

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-card-foreground">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Bot className="h-4 w-4 text-primary" />
          </div>
          Connect an AI assistant
        </DialogTitle>
        <DialogDescription className="text-muted-foreground">
          An assistant such as Claude can read this ClearPing over MCP: what is monitored, every outage with its times,
          the traceroutes. Give it the address below, then ask it in your own words.
        </DialogDescription>
      </DialogHeader>

      <div className="min-w-0 space-y-4">
        <CopyField id="mcp-url" label="MCP server address" value={url} />

        {tokenWouldBeRefused && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-foreground" role="alert">
            This address is not encrypted. ClearPing asks for a token here and will not take one over plain HTTP from
            outside its own network, where anything on the way could read it. Put ClearPing behind HTTPS and open this
            page at its <span className="font-mono">https://</span> address first.
          </p>
        )}

        <div className="space-y-3">
          <div
            className="grid grid-cols-3 gap-0.5 rounded-lg border border-border bg-muted/30 p-0.5"
            role="tablist"
            aria-label="Which assistant"
          >
            {CLIENTS.map(option => (
              <button
                key={option.value}
                type="button"
                role="tab"
                id={`mcp-tab-${option.value}`}
                aria-selected={client === option.value}
                aria-controls={`mcp-panel-${option.value}`}
                onClick={() => setClient(option.value)}
                className={cn(
                  'cursor-pointer rounded-md px-2 py-1.5 text-xs outline-none transition-colors touch:py-2.5',
                  'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  client === option.value
                    ? 'bg-primary font-medium text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`mcp-panel-${client}`} aria-labelledby={`mcp-tab-${client}`} className="space-y-2">
            {client === 'claude-code' && (
              <>
                <CopyField id="mcp-command" label="Run this once, in a terminal" value={command} />
                <p className={HINT}>
                  Then start Claude Code and ask. <span className="font-mono">/mcp</span> inside it shows whether
                  ClearPing is connected.
                </p>
              </>
            )}

            {client === 'claude-app' && (
              <>
                <Fold
                  title="ClearPing is on my own network"
                  detail="Claude Desktop, through its configuration file"
                  open={reach === 'local'}
                  onToggle={() => toggleReach('local')}
                >
                  <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-card-foreground">
                    <li>
                      In Claude Desktop, open <span className="font-medium">Settings</span>, then{' '}
                      <span className="font-medium">Developer</span>, and choose{' '}
                      <span className="font-medium">Edit Config</span>. It opens{' '}
                      <span className="font-mono">claude_desktop_config.json</span>.
                    </li>
                    <li>
                      Put the text below in it. If the file already lists other servers, add only the{' '}
                      <span className="font-mono">clearping</span> part, inside the{' '}
                      <span className="font-mono">mcpServers</span> it has.
                    </li>
                    <li>Save, quit Claude Desktop altogether, and open it again.</li>
                  </ol>
                  <CopyField id="mcp-desktop-config" label="In claude_desktop_config.json" value={desktopConfig} multiline />
                  {tokenRequired && (
                    <p className={HINT}>
                      This ClearPing asks for a token. Put the value of{' '}
                      <span className="font-mono">CLEARPING_MCP_TOKEN</span> where it says{' '}
                      <span className="font-mono">{TOKEN_PLACEHOLDER}</span>.
                    </p>
                  )}
                  <p className={HINT}>
                    This runs a small bridge, <span className="font-mono">mcp-remote</span>, on the computer Claude
                    Desktop is on, so whatever that computer can reach, Claude can: an address starting 192.168 or 10,
                    a name like <span className="font-mono">clearping.lan</span>, or localhost. The computer needs{' '}
                    <span className="font-medium">Node.js</span> 18 or newer, which is where{' '}
                    <span className="font-mono">npx</span> comes from; the bridge is fetched the first time it is used.
                  </p>
                </Fold>

                <Fold
                  title="ClearPing can be reached from the internet"
                  detail="claude.ai and any Claude app, as a connector"
                  open={reach === 'remote'}
                  onToggle={() => toggleReach('remote')}
                >
                  <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-card-foreground">
                    <li>Open <span className="font-medium">Settings</span>, then <span className="font-medium">Connectors</span>.</li>
                    <li>Choose <span className="font-medium">Add custom connector</span>.</li>
                    <li>Name it ClearPing and paste the address above.</li>
                  </ol>
                  <p className={HINT}>
                    A connector connects from Anthropic&apos;s servers and not from your computer, so it only works
                    where the address above can be reached from the internet. A ClearPing on a home or office network
                    (an address starting 192.168 or 10, or localhost) cannot be: that is what the way above is for.
                  </p>
                  {tokenRequired && (
                    <p className={HINT}>
                      This ClearPing asks for a token. A connector signs in another way (OAuth) and has no field for a
                      token like this one, so it cannot connect while one is set. Claude Desktop, set up the way
                      above, and Claude Code can.
                    </p>
                  )}
                </Fold>
              </>
            )}

            {client === 'other' && (
              <>
                <CopyField id="mcp-config" label="As configuration, for a client that takes a file" value={config} multiline />
                <p className={HINT}>
                  Add it as a remote server over HTTP (also called Streamable HTTP) at the address above. The key the
                  file wants differs between clients: some take <span className="font-mono">servers</span> where this
                  has <span className="font-mono">mcpServers</span>.
                </p>
              </>
            )}

            {tokenRequired && client !== 'claude-app' && (
              <p className={HINT}>
                This ClearPing asks for a token. Put the value of{' '}
                <span className="font-mono">CLEARPING_MCP_TOKEN</span> where it says{' '}
                <span className="font-mono">{TOKEN_PLACEHOLDER}</span>.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className={FIELD_LABEL}>Then ask it something like</p>
          <ul className="space-y-1">
            {(tokenRequired ? [...EXAMPLES, WRITE_EXAMPLE] : EXAMPLES).map(example => (
              <li key={example} className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs text-card-foreground">
                {example}
              </li>
            ))}
          </ul>
        </div>

        <p className={HINT}>
          {tokenRequired ? (
            <>
              With the token, an assistant can also add targets, change them, pause them, probe one now and trace a
              route. It cannot delete a target, and alerts are never shown to it.
            </>
          ) : (
            <>
              An assistant can only read: it cannot add, change, pause or probe a target, and alerts are never shown to
              it. To let one add and change targets as well, set <span className="font-mono">CLEARPING_MCP_TOKEN</span>{' '}
              where ClearPing runs. It is then asked for on every connection.
            </>
          )}{' '}
          The report is only as good as what is monitored: with your router as a target as well as addresses beyond
          it, the data can show whether a fault was inside your network or outside it.
        </p>
      </div>
    </>
  )
}

interface McpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function McpDialog({ open, onOpenChange }: McpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-xl" suppressHydrationWarning>
        {/* Inside the dialog's content, which is there only while it is open:
            the address is read off the page it was opened from. */}
        <McpDialogBody />
      </DialogContent>
    </Dialog>
  )
}
