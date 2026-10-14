'use client'

import { Plus, X } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { Input } from '@/components/arc/input/input'
import { SegmentedField } from '@/components/segmented-field'
import { Select } from '@/components/arc/select/select'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
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
    <fieldset className="space-y-3">
      <legend className="pb-2 text-sm font-medium text-card-foreground">Ask these resolvers</legend>

      <ul className="space-y-2">
        {rows.map((row, index) => {
          const who = row.protocol === 'system' ? SYSTEM_VALUE : shownProvider(row)?.id ?? CUSTOM_VALUE
          const isCustom = who === CUSTOM_VALUE
          const position = `Resolver ${index + 1}`

          return (
            // By position: a row has nothing else that stays the same while it
            // is being typed in, and rows are only ever added at the end.
            <li key={index} className="space-y-3 rounded-2xl border border-border p-3">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Select
                    id={`${idPrefix}-resolver-${index}`}
                    label={position}
                    value={who}
                    onValueChange={value => {
                      if (value === SYSTEM_VALUE) return setRow(index, SYSTEM)
                      const protocol: AskedProtocol = row.protocol === 'system' ? lastProtocol ?? 'udp' : row.protocol
                      const provider = DNS_PROVIDERS.find(each => each.id === value)
                      setRow(index, provider ? providerResolver(provider, protocol) : { protocol, server: '', name: '' })
                    }}
                    options={[
                      { value: SYSTEM_VALUE, label: 'System' },
                      ...DNS_PROVIDERS.map(provider => ({ value: provider.id, label: provider.name })),
                      { value: CUSTOM_VALUE, label: 'Custom' },
                    ]}
                  />
                </div>
                {rows.length > 1 && (
                  <Tooltip content="Remove this resolver">
                    <Button type="button" variant="ghost" onClick={() => removeRow(index)} aria-label={`Remove ${resolverLabel(row) || position}`}>
                      <X size={16} strokeWidth={1.75} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                )}
              </div>

              {row.protocol === 'system' ? (
                <p className="text-xs text-muted-foreground">Whatever this machine uses for every other lookup.</p>
              ) : (
                <>
                  <SegmentedField
                    label="How to ask"
                    value={row.protocol}
                    onValueChange={protocol => setRow(index, withProtocol(row, protocol as AskedProtocol))}
                    options={ASKED_PROTOCOLS.map(protocol => ({ value: protocol, label: DNS_PROTOCOL_LABEL[protocol] }))}
                  />
                  {isCustom && (
                    <Input
                      label="Its name (optional)"
                      value={row.name ?? ''}
                      maxLength={MAX_RESOLVER_NAME_LENGTH}
                      onChange={event => setRow(index, { ...row, name: event.target.value })}
                    />
                  )}
                  <Input
                    label={`Where it is (${DNS_PROTOCOL_NAME[row.protocol]})`}
                    placeholder={PLACEHOLDER[row.protocol]}
                    value={row.server ?? ''}
                    onChange={event => setRow(index, { ...row, server: event.target.value })}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    style={{ fontFamily: 'var(--font-plex-mono), ui-monospace, monospace' }}
                  />
                </>
              )}
            </li>
          )
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={addRow} disabled={full}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          Add resolver
        </Button>
        {!hasAnyOfThem && rows.length + bigThree.length <= MAX_DNS_RESOLVERS && (
          <Button type="button" variant="ghost" size="sm" onClick={addBigThree}>
            Add {bigThree.map(provider => provider.name).join(', ').replace(/, ([^,]*)$/, ' and $1')}
          </Button>
        )}
        {full && <span className="text-xs text-muted-foreground">{MAX_DNS_RESOLVERS} is the most one target can ask.</span>}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {rows.length > 1
          ? 'Each is asked on every probe and timed by itself, so the same lookup can be seen as each of them answers it.'
          : 'Add more to see the same lookup as each of them answers it.'}{' '}
        DoT is DNS over TLS and DoH is DNS over HTTPS, the two encrypted ways of asking.
        {hasCustom && ' A custom resolver is listed under the name you give it, or under its address without one.'}
      </p>
    </fieldset>
  )
}
