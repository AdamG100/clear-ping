'use client'

import { Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  DNS_PROTOCOL_LABEL,
  DNS_PROTOCOL_NAME,
  DNS_PROVIDERS,
  MAX_DNS_RESOLVERS,
  MAX_RESOLVER_NAME_LENGTH,
  parseDohServer,
  providerOf,
  providerResolver,
  resolverLabel,
} from '@/lib/dns-resolvers'
import type { DnsProtocol, DnsResolver } from '@/types/probe'

/**
 * The resolvers a DNS target's name is looked up through.
 *
 * One row for each, and a button to add another: the point of the list is to
 * have several, so that one probe shows the same lookup as each of them sees
 * it. A row is who to ask, how to ask them, and where they are. Picking one
 * of the well-known ones fills in where. A custom one is given by its address
 * and can be given a name, which it is then called by.
 */

type AskedProtocol = Exclude<DnsProtocol, 'system'>

const ASKED_PROTOCOLS: readonly AskedProtocol[] = ['udp', 'dot', 'doh']

const SYSTEM: DnsResolver = { protocol: 'system' }
const SYSTEM_VALUE = 'system'
const CUSTOM_VALUE = 'custom'

const PLACEHOLDER: Record<AskedProtocol, string> = {
  udp: '9.9.9.9',
  dot: 'dns.example.net',
  doh: 'https://dns.example.net/dns-query',
}

const FIELD_INPUT = 'bg-input border-border text-foreground h-9 text-sm'

/**
 * The provider a row is showing, if it is showing one. A row that has a name
 * of its own, even one not typed yet, is a custom one wherever it points:
 * typing 1.1.1.1 into it must not turn it into Cloudflare and take the name
 * box away.
 */
function shownProvider(row: DnsResolver) {
  return row.name === undefined ? providerOf(row) : null
}

/** A resolver's address carried over to another protocol, as far as it can be. */
function withProtocol(resolver: DnsResolver, protocol: AskedProtocol): DnsResolver {
  const provider = shownProvider(resolver)
  if (provider) return providerResolver(provider, protocol)

  // A URL is only an address to DNS over HTTPS; the others want the host in it.
  const server = resolver.protocol === 'doh' ? parseDohServer(resolver.server ?? '')?.hostname ?? '' : resolver.server ?? ''
  return { ...resolver, protocol, server }
}

interface ResolverListProps {
  idPrefix: string
  /** Empty for the system resolver alone, which is what a target has until it is given others. */
  resolvers: DnsResolver[]
  onChange: (resolvers: DnsResolver[]) => void
}

export function ResolverList({ idPrefix, resolvers, onChange }: ResolverListProps) {
  // The system resolver alone is not stored as a list of one, but it is shown
  // as one: a row to change, and something to add to.
  const rows = resolvers.length > 0 ? resolvers : [SYSTEM]

  const commit = (next: DnsResolver[]) => {
    onChange(next.length === 1 && next[0].protocol === 'system' ? [] : next)
  }
  const setRow = (index: number, resolver: DnsResolver) => commit(rows.map((row, at) => (at === index ? resolver : row)))
  const removeRow = (index: number) => commit(rows.filter((_, at) => at !== index))

  // The protocol a new row starts with: whatever the last one was asked over,
  // since a list is usually all one kind.
  const lastProtocol = [...rows].reverse().find(row => row.protocol !== 'system')?.protocol as AskedProtocol | undefined
  const listed = new Set(rows.map(resolverLabel))

  const addRow = () => {
    const protocol = lastProtocol ?? 'udp'
    const next = DNS_PROVIDERS.map(provider => providerResolver(provider, protocol)).find(
      resolver => !listed.has(resolverLabel(resolver))
    )
    commit([...rows, next ?? { protocol, server: '', name: '' }])
  }

  // The three most people mean by "the public resolvers", in one press.
  const bigThree = DNS_PROVIDERS.slice(0, 3)
  const hasAnyOfThem = rows.some(row => bigThree.some(provider => providerOf(row)?.id === provider.id))
  const addBigThree = () => {
    const protocol = lastProtocol ?? 'udp'
    commit([...rows, ...bigThree.map(provider => providerResolver(provider, protocol))])
  }

  const full = rows.length >= MAX_DNS_RESOLVERS
  const hasCustom = rows.some(row => row.protocol !== 'system' && !shownProvider(row))

  return (
    <div className="space-y-2">
      <Label className="gap-1.5 text-xs text-card-foreground">Ask these resolvers</Label>

      <ul className="space-y-2">
        {rows.map((row, index) => {
          const who = row.protocol === 'system' ? SYSTEM_VALUE : shownProvider(row)?.id ?? CUSTOM_VALUE
          const isCustom = who === CUSTOM_VALUE
          const position = `Resolver ${index + 1}`

          return (
            // By position: a row has nothing else that stays the same while it
            // is being typed in, and rows are only ever added at the end.
            <li key={index} className="flex flex-wrap items-center gap-2">
              <Select
                value={who}
                onValueChange={value => {
                  if (value === SYSTEM_VALUE) return setRow(index, SYSTEM)
                  const protocol: AskedProtocol = row.protocol === 'system' ? lastProtocol ?? 'udp' : row.protocol
                  const provider = DNS_PROVIDERS.find(each => each.id === value)
                  setRow(index, provider ? providerResolver(provider, protocol) : { protocol, server: '', name: '' })
                }}
              >
                <SelectTrigger id={`${idPrefix}-resolver-${index}`} aria-label={`${position}: who to ask`} className={cn(FIELD_INPUT, 'w-36 shrink-0')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-popover border-border">
                  <SelectItem value={SYSTEM_VALUE}>System</SelectItem>
                  <SelectSeparator />
                  {DNS_PROVIDERS.map(provider => (
                    <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectItem value={CUSTOM_VALUE}>Custom</SelectItem>
                </SelectContent>
              </Select>

              {row.protocol === 'system' ? (
                <p className="min-w-0 flex-1 basis-40 text-xs text-muted-foreground">
                  Whatever this machine uses for every other lookup.
                </p>
              ) : (
                <>
                  {/* One tray, so the three read as a single setting. */}
                  <div
                    className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-muted/30 p-0.5"
                    role="radiogroup"
                    aria-label={`${position}: how to ask`}
                  >
                    {ASKED_PROTOCOLS.map(protocol => (
                      <button
                        key={protocol}
                        type="button"
                        role="radio"
                        aria-checked={row.protocol === protocol}
                        data-tip={DNS_PROTOCOL_NAME[protocol]}
                        onClick={() => setRow(index, withProtocol(row, protocol))}
                        className={cn(
                          'cursor-pointer rounded-md px-2 py-1.5 text-xs outline-none transition-colors touch:py-2.5',
                          'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                          row.protocol === protocol
                            ? 'bg-primary font-medium text-primary-foreground'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        )}
                      >
                        {DNS_PROTOCOL_LABEL[protocol]}
                      </button>
                    ))}
                  </div>
                  {isCustom && (
                    <Input
                      aria-label={`${position}: its name`}
                      placeholder="Name (optional)"
                      value={row.name ?? ''}
                      maxLength={MAX_RESOLVER_NAME_LENGTH}
                      onChange={event => setRow(index, { ...row, name: event.target.value })}
                      className={cn(FIELD_INPUT, 'min-w-0 flex-1 basis-28 text-xs md:text-xs')}
                    />
                  )}
                  <Input
                    aria-label={`${position}: where it is`}
                    placeholder={PLACEHOLDER[row.protocol]}
                    value={row.server ?? ''}
                    onChange={event => setRow(index, { ...row, server: event.target.value })}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className={cn(
                      FIELD_INPUT,
                      'min-w-0 font-mono text-xs md:text-xs',
                      // A custom one has its name on the first line, so where
                      // it is takes the whole of a second, after the remove button.
                      isCustom ? 'order-last basis-full' : 'flex-1 basis-40'
                    )}
                  />
                </>
              )}

              {rows.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  aria-label={`Remove ${resolverLabel(row) || position}`}
                  data-tip="Remove this resolver"
                  className="shrink-0 cursor-pointer rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground touch:p-2.5"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          )
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={addRow}
          disabled={full}
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-ring/60 hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 touch:py-2.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Add resolver
        </button>
        {!hasAnyOfThem && rows.length + bigThree.length <= MAX_DNS_RESOLVERS && (
          <button
            type="button"
            onClick={addBigThree}
            className="cursor-pointer text-xs text-primary underline-offset-2 hover:underline touch:py-1.5"
          >
            Add {bigThree.map(provider => provider.name).join(', ').replace(/, ([^,]*)$/, ' and $1')}
          </button>
        )}
        {full && <span className="text-[11px] text-muted-foreground">{MAX_DNS_RESOLVERS} is the most one target can ask.</span>}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {rows.length > 1
          ? 'Each is asked on every probe and timed by itself, so the same lookup can be seen as each of them answers it.'
          : 'Add more to see the same lookup as each of them answers it.'}{' '}
        DoT is DNS over TLS and DoH is DNS over HTTPS, the two encrypted ways of asking.
        {hasCustom && ' A custom resolver is listed under the name you give it, or under its address without one.'}
      </p>
    </div>
  )
}
