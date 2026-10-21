'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { KeyRound } from 'lucide-react'
import { Accordion } from '@/components/arc/accordion/accordion'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'
import { CodeBlock } from '@/components/arc/code-block/code-block'
import { CopyButton } from '@/components/arc/copy-button/copy-button'
import { Input } from '@/components/arc/input/input'
import { Skeleton } from '@/components/arc/skeleton/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/arc/tabs/tabs'
import { isLocalHost } from '@/lib/probes/host'

/**
 * How to connect an AI assistant to this ClearPing.
 *
 * The app can be read over MCP, and nobody would know: it is an address that
 * answers to a program, with nothing on any page to say it is there. This is
 * the page that says so, with the address to give the assistant and what to
 * type for the commonest of them.
 */

const HINT = 'text-xs leading-relaxed text-muted-foreground'

/** Stands in the command where the key goes: the page is never told a key once it has been made. */
const TOKEN_PLACEHOLDER = 'YOUR_KEY'

type Client = 'claude-code' | 'claude-app' | 'other'

const CLIENTS: { value: Client; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'claude-app', label: 'Claude apps' },
  { value: 'other', label: 'Another client' },
]

/** Things worth asking, as they would be typed. */
const EXAMPLES = [
  'Gather the logs from the last week so I can report this to my ISP, as a PDF.',
  'Which targets had outages yesterday, and what kept working while they were down?',
  'Is my connection worse in the evenings?',
  'Is one of my DNS resolvers slower than the others?',
]

/** And one for an assistant that is allowed to change things. */
const WRITE_EXAMPLE = 'Add my router, my ISP\'s gateway and 1.1.1.1 as ping targets, in a group called Network.'

/**
 * Something to be copied: a value on one line, shown whole in a field with a
 * button that copies it. Where the browser will not copy (a page served over
 * plain http, from anywhere but this machine, is not given a clipboard), the
 * field selects itself when pressed, for copying by hand.
 */
export function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Input id={id} label={label} readOnly value={value} onFocus={event => event.target.select()} style={{ fontFamily: 'var(--font-plex-mono), ui-monospace, monospace' }} />
      </div>
      {/* Centred on the field, which is a size taller than the button. */}
      <div className="mb-1 shrink-0">
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} iconOnly />
      </div>
    </div>
  )
}

/** A section of a page in the dashboard's own card. */
export const PAGE_CARD = 'min-w-0 space-y-4 rounded-3xl border border-border bg-card p-4 text-card-foreground @2xl/main:p-6'
export const PAGE_CARD_TITLE = 'text-sm font-medium text-card-foreground'

const noSubscription = () => () => {}

/** Whether this is the browser, which is where the page's own address is known. False while rendering on the server. */
export function useInBrowser(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false)
}

function McpSetup({ onMakeKey }: { onMakeKey?: () => void }) {
  const [client, setClient] = useState<Client>('claude-code')
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
  // The way into the Claude apps that fits where this ClearPing is, open first.
  // On your own network only a program on your computer can reach it, and
  // Claude Desktop can start one; out on the internet, Claude's servers can
  // reach it themselves, from any of the apps.
  const local = isLocalHost(window.location.host)
  // A key is not taken in the clear from across the internet. Said here,
  // before it is tried, where the page itself was reached that way.
  const tokenWouldBeRefused = !info.plainHttpAllowed && window.location.protocol !== 'https:' && !local
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

  const desktopWay = (
    <div className="space-y-3">
      <ol className="list-decimal space-y-1 pl-4 text-sm leading-relaxed text-card-foreground">
        <li>
          In Claude Desktop, open <span className="font-medium">Settings</span>, then{' '}
          <span className="font-medium">Developer</span>, and choose <span className="font-medium">Edit Config</span>.
          It opens <span className="font-mono">claude_desktop_config.json</span>.
        </li>
        <li>
          Put the text below in it. If the file already lists other servers, add only the{' '}
          <span className="font-mono">clearping</span> part, inside the <span className="font-mono">mcpServers</span> it
          has.
        </li>
        <li>Save, quit Claude Desktop altogether, and open it again.</li>
      </ol>
      <CodeBlock code={desktopConfig} filename="claude_desktop_config.json" language="json" />
      <p className={HINT}>
        This runs a small bridge, <span className="font-mono">mcp-remote</span>, on the computer Claude Desktop is on,
        so whatever that computer can reach, Claude can: an address starting 192.168 or 10, a name like{' '}
        <span className="font-mono">clearping.lan</span>, or localhost. The computer needs{' '}
        <span className="font-medium">Node.js</span> 18 or newer, which is where <span className="font-mono">npx</span>{' '}
        comes from; the bridge is fetched the first time it is used.
      </p>
    </div>
  )

  const connectorWay = (
    <div className="space-y-3">
      <ol className="list-decimal space-y-1 pl-4 text-sm leading-relaxed text-card-foreground">
        <li>Open <span className="font-medium">Settings</span>, then <span className="font-medium">Connectors</span>.</li>
        <li>Choose <span className="font-medium">Add custom connector</span>.</li>
        <li>Name it ClearPing and paste the address above.</li>
      </ol>
      <p className={HINT}>
        A connector connects from Anthropic&apos;s servers and not from your computer, so it only works where the
        address above can be reached from the internet. A ClearPing on a home or office network (an address starting
        192.168 or 10, or localhost) cannot be: that is what the other way is for.
      </p>
      <p className={HINT}>
        A connector signs in another way (OAuth) and has no field for a key, so it connects as nobody in particular: it
        can only read, and {tokenRequired ? 'cannot connect at all while this ClearPing asks for a key' : 'only while this ClearPing does not ask for a key'}.
        Claude Desktop, set up the other way, and Claude Code can send one.
      </p>
    </div>
  )

  const ways = [
    { title: 'ClearPing is on my own network: Claude Desktop, through its configuration file', content: desktopWay },
    { title: 'ClearPing can be reached from the internet: claude.ai and any Claude app, as a connector', content: connectorWay },
  ]

  return (
    <div className="space-y-4">
      <section className={PAGE_CARD} aria-labelledby="mcp-setup-title">
        <h2 id="mcp-setup-title" className={PAGE_CARD_TITLE}>Set it up</h2>
        <CopyField id="mcp-url" label="MCP server address" value={url} />

        {tokenWouldBeRefused && (
          <Alert tone="danger" title="This address is not encrypted">
            ClearPing will not take a key over plain HTTP from outside its own network, where anything on the way could
            read it. Put ClearPing behind HTTPS and open this page at its https:// address first.
          </Alert>
        )}

        <Tabs value={client} onValueChange={value => setClient(value as Client)}>
          <TabsList aria-label="Which assistant">
            {CLIENTS.map(option => (
              <TabsTrigger key={option.value} value={option.value}>
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="claude-code">
            <div className="space-y-2">
              <CodeBlock code={command} filename="Run this once, in a terminal" language="bash" />
              <p className={HINT}>
                Then start Claude Code and ask. <span className="font-mono">/mcp</span> inside it shows whether
                ClearPing is connected.
              </p>
            </div>
          </TabsContent>

          <TabsContent value="claude-app">
            {/* Local first where this page was opened on the local network, so the way that applies is the one open. */}
            <Accordion items={local ? ways : [...ways].reverse()} />
          </TabsContent>

          <TabsContent value="other">
            <div className="space-y-2">
              <CodeBlock code={config} filename="As configuration, for a client that takes a file" language="json" />
              <p className={HINT}>
                Add it as a remote server over HTTP (also called Streamable HTTP) at the address above. The key the file
                wants differs between clients: some take <span className="font-mono">servers</span> where this has{' '}
                <span className="font-mono">mcpServers</span>.
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </section>

      <section className={PAGE_CARD} aria-labelledby="mcp-keys-title">
        <h2 id="mcp-keys-title" className={PAGE_CARD_TITLE}>A key for each assistant</h2>
        <p className="text-sm leading-relaxed text-card-foreground">
          Give each assistant a key of its own, and put it where it says{' '}
          <span className="font-mono">{TOKEN_PLACEHOLDER}</span>. A <span className="font-medium">read-only</span> key
          lets it read; a <span className="font-medium">read and change</span> key lets it add and change targets as
          well. Whatever it changes is recorded under the key&apos;s name, and revoking the key cuts that assistant off
          alone.
        </p>
        <p className={HINT}>
          {tokenRequired
            ? 'This ClearPing asks for a key on every connection.'
            : 'Without a key an assistant can still read, but not change anything.'}
        </p>
        {onMakeKey && (
          <Button type="button" variant="secondary" size="sm" onClick={onMakeKey}>
            <KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />
            Create a key
          </Button>
        )}
      </section>

      <section className={PAGE_CARD} aria-labelledby="mcp-ask-title">
        <h2 id="mcp-ask-title" className={PAGE_CARD_TITLE}>Then ask it something like</h2>
        <ul className="space-y-1.5">
          {[...EXAMPLES, WRITE_EXAMPLE].map(example => (
            <li key={example} className="rounded-xl border border-border bg-muted px-3 py-2 text-sm text-card-foreground">
              {example}
            </li>
          ))}
        </ul>
        <p className={HINT}>
          The last of those needs a read and change key. With one, an assistant can add targets, change them, pause
          them, probe one now and trace a route; it cannot delete a target, and alerts are never shown to it. The report
          is only as good as what is monitored: with your router as a target as well as addresses beyond it, the data can
          show whether a fault was inside your network or outside it.
        </p>
      </section>
    </div>
  )
}

/**
 * Settings → AI assistant: connecting one over MCP.
 *
 * The address it gives is the one this page was opened at, which is only
 * known in the browser: on the server the setup is not drawn yet.
 */
export function AssistantSettings({ onMakeKey }: { onMakeKey?: () => void }) {
  const inBrowser = useInBrowser()

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        An assistant such as Claude can read this ClearPing over MCP: what is monitored, every outage with its times,
        the traceroutes. Give it the address below, then ask it in your own words.
      </p>
      {inBrowser ? <McpSetup onMakeKey={onMakeKey} /> : <Skeleton label="Loading the setup" lines={4} />}
    </div>
  )
}
