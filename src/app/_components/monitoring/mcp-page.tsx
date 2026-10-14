'use client'

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check, ChevronRight, Copy, KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isLocalHost } from '@/lib/host'
import { cn } from '@/lib/utils'
import { PANE, PANE_HEADER, PANE_TITLE } from './pane-layout'

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

/** Stands in the command where the key goes: the page is never told a key once it has been made. */
const TOKEN_PLACEHOLDER = 'YOUR_KEY'

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
export function CopyField({ id, label, value, multiline = false }: { id: string; label: string; value: string; multiline?: boolean }) {
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

/** A section of a page in the dashboard's own card. */
export const PAGE_CARD = 'min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 @2xl/main:p-5'
export const PAGE_CARD_TITLE = 'text-sm font-semibold text-card-foreground'

const noSubscription = () => () => {}

/** Whether this is the browser, which is where the page's own address is known. False while rendering on the server. */
export function useInBrowser(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false)
}

function McpSetup({ onMakeKey }: { onMakeKey?: () => void }) {
  const [client, setClient] = useState<Client>('claude-code')
  // Open on the way that fits the address this page was reached at. One at a
  // time: opening the other puts this one away.
  const [reach, setReach] = useState<Reach | null>(() => (isLocalHost(window.location.host) ? 'local' : 'remote'))
  const toggleReach = (which: Reach) => setReach(reach === which ? null : which)
  // Whether a key has to be sent even to read. Not known until asked, and
  // taken as not needed if asking fails: the address is right either way.
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
  // A key is not taken in the clear from across the internet. Said here,
  // before it is tried, where the page itself was reached that way.
  const tokenWouldBeRefused =
    !info.plainHttpAllowed && window.location.protocol !== 'https:' && !isLocalHost(window.location.host)
  const header = `Authorization: Bearer ${TOKEN_PLACEHOLDER}`

  const command = `claude mcp add --transport http clearping ${url} --header "${header}"`
  const config = JSON.stringify(
    { mcpServers: { clearping: { type: 'http', url, headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` } } } },
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
            '--header',
            'Authorization:${AUTH_HEADER}',
          ],
          env: { AUTH_HEADER: `Bearer ${TOKEN_PLACEHOLDER}` },
        },
      },
    },
    null,
    2
  )

  return (
    <div className="grid items-start gap-4 @2xl/main:gap-6 @5xl/main:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section className={PAGE_CARD} aria-labelledby="mcp-setup-title">
        <h2 id="mcp-setup-title" className={PAGE_CARD_TITLE}>Set it up</h2>
        <CopyField id="mcp-url" label="MCP server address" value={url} />

        {tokenWouldBeRefused && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-foreground" role="alert">
            This address is not encrypted. ClearPing will not take a key over plain HTTP from outside its own network,
            where anything on the way could read it. Put ClearPing behind HTTPS and open this page at its{' '}
            <span className="font-mono">https://</span> address first.
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
                  <p className={HINT}>
                    A connector signs in another way (OAuth) and has no field for a key, so it connects as nobody in
                    particular: it can only read, and {tokenRequired ? 'cannot connect at all while this ClearPing asks for a key' : 'only while this ClearPing does not ask for a key'}.
                    Claude Desktop, set up the way above, and Claude Code can send one.
                  </p>
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

          </div>
        </div>
      </section>

      <div className="min-w-0 space-y-4 @2xl/main:space-y-6">
        <section className={PAGE_CARD} aria-labelledby="mcp-keys-title">
          <h2 id="mcp-keys-title" className={PAGE_CARD_TITLE}>A key for each assistant</h2>
          <p className="text-xs leading-relaxed text-card-foreground">
            Give each assistant a key of its own, and put it where it says{' '}
            <span className="font-mono">{TOKEN_PLACEHOLDER}</span>. A <span className="font-medium">read-only</span> key
            lets it read; a <span className="font-medium">read and change</span> key lets it add and change targets as
            well. Whatever it changes is recorded under the key&apos;s name, and revoking the key cuts that assistant
            off alone.
          </p>
          <p className={HINT}>
            {tokenRequired
              ? 'This ClearPing asks for a key on every connection.'
              : 'Without a key an assistant can still read, but not change anything.'}
          </p>
          {onMakeKey && (
            <Button type="button" variant="outline" size="sm" onClick={onMakeKey}>
              <KeyRound className="h-4 w-4" />
              Make a key
            </Button>
          )}
        </section>

        <section className={PAGE_CARD} aria-labelledby="mcp-ask-title">
          <h2 id="mcp-ask-title" className={PAGE_CARD_TITLE}>Then ask it something like</h2>
          <ul className="space-y-1.5">
            {[...EXAMPLES, WRITE_EXAMPLE].map(example => (
              <li key={example} className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs text-card-foreground">
                {example}
              </li>
            ))}
          </ul>
          <p className={HINT}>
            The last of those needs a read and change key. With one, an assistant can add targets, change them, pause
            them, probe one now and trace a route; it cannot delete a target, and alerts are never shown to it. The
            report is only as good as what is monitored: with your router as a target as well as addresses beyond it,
            the data can show whether a fault was inside your network or outside it.
          </p>
        </section>
      </div>
    </div>
  )
}

/**
 * The dashboard's page for connecting an AI assistant, at /mcp.
 *
 * The address it gives is the one this page was opened at, which is only
 * known in the browser: on the server the setup is not drawn yet.
 */
export function McpPage({ onMakeKey }: { onMakeKey?: () => void }) {
  const inBrowser = useInBrowser()

  return (
    <div className={PANE}>
      <header className={PANE_HEADER}>
        <div className="min-w-0">
          <h1 className={PANE_TITLE}>Connect an AI assistant</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            An assistant such as Claude can read this ClearPing over MCP: what is monitored, every outage with its
            times, the traceroutes. Give it the address below, then ask it in your own words.
          </p>
        </div>
      </header>

      {inBrowser ? <McpSetup onMakeKey={onMakeKey} /> : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
    </div>
  )
}
