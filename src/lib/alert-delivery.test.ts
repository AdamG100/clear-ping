import { describe, expect, it } from 'vitest'
import type { AlertEvent } from '@/types/probe'
import {
  alertTitle,
  describeCondition,
  discordPayload,
  isDiscordWebhook,
  parseMentionIds,
  payloadFor,
  webhookPayload,
} from './alert-delivery'

const ROLE = '111111111111111111'
const USER = '222222222222222222'

function event(over: Partial<AlertEvent> = {}, rule: Partial<AlertEvent['rule']> = {}): AlertEvent {
  return {
    rule: {
      id: 'alert-1',
      targetId: 'target-1',
      metric: 'packetLoss',
      threshold: 5,
      consecutiveProbes: 3,
      destination: 'discord',
      webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/token',
      mentionRoleIds: [ROLE],
      mentionUserIds: [USER],
      enabled: true,
      state: 'firing',
      streak: 0,
      createdAt: new Date(0),
      ...rule,
    },
    targetName: 'Router',
    targetHost: '192.0.2.1',
    targetGroup: 'Home/Network',
    transition: 'firing',
    metric: 'packetLoss',
    observed: 42.53,
    threshold: 5,
    at: new Date('2026-08-19T22:41:43.911Z'),
    ...over,
  }
}

describe('isDiscordWebhook', () => {
  it('recognises Discord webhook URLs, on any of its hosts and API versions', () => {
    expect(isDiscordWebhook('https://discord.com/api/webhooks/123456789012345678/abc-DEF_123')).toBe(true)
    expect(isDiscordWebhook('https://discordapp.com/api/webhooks/123456789012345678/abc')).toBe(true)
    expect(isDiscordWebhook('https://canary.discord.com/api/v10/webhooks/123456789012345678/abc')).toBe(true)
    expect(isDiscordWebhook('https://discord.com/api/webhooks/123456789012345678/abc?wait=true')).toBe(true)
  })

  it('leaves the Slack- and GitHub-compatible endpoints to the plain payload', () => {
    expect(isDiscordWebhook('https://discord.com/api/webhooks/123456789012345678/abc/slack')).toBe(false)
    expect(isDiscordWebhook('https://discord.com/api/webhooks/123456789012345678/abc/github')).toBe(false)
  })

  it('is false for anything else', () => {
    expect(isDiscordWebhook('https://hooks.example.com/api/webhooks/123/abc')).toBe(false)
    expect(isDiscordWebhook('https://discord.com.evil.example/api/webhooks/123/abc')).toBe(false)
    expect(isDiscordWebhook('not a url')).toBe(false)
    expect(isDiscordWebhook('')).toBe(false)
    expect(isDiscordWebhook(undefined)).toBe(false)
  })
})

describe('parseMentionIds', () => {
  it('reads ids separated by commas, spaces or both', () => {
    expect(parseMentionIds(`${ROLE}, ${USER}`)).toEqual([ROLE, USER])
    expect(parseMentionIds(`${ROLE} ${USER}\n`)).toEqual([ROLE, USER])
    expect(parseMentionIds([ROLE, USER])).toEqual([ROLE, USER])
  })

  it('accepts a mention as Discord copies it', () => {
    expect(parseMentionIds(`<@&${ROLE}> <@${USER}> <@!${USER}>`)).toEqual([ROLE, USER])
  })

  it('reads nothing as no ids', () => {
    expect(parseMentionIds('')).toEqual([])
    expect(parseMentionIds(undefined)).toEqual([])
    expect(parseMentionIds([])).toEqual([])
  })

  it('refuses anything that is not an id, rather than dropping it', () => {
    expect(parseMentionIds('@everyone')).toBeNull()
    expect(parseMentionIds(`${ROLE}, moderators`)).toBeNull()
    expect(parseMentionIds('12345')).toBeNull()
    expect(parseMentionIds(42)).toBeNull()
  })
})

describe('describing an alert', () => {
  it('words each kind of condition', () => {
    expect(describeCondition({ metric: 'unreachable', threshold: 0 })).toBe('Stops responding')
    expect(describeCondition({ metric: 'packetLoss', threshold: 5 })).toBe('Packet loss above 5%')
    expect(describeCondition({ metric: 'latency', threshold: 200 })).toBe('Latency above 200ms')
    expect(describeCondition({ metric: 'certExpiry', threshold: 14 })).toBe('Certificate expires within 14 days')
  })

  it('calls an alert by its name when it has one', () => {
    expect(alertTitle({ name: 'Uplink', metric: 'packetLoss', threshold: 5 })).toBe('Uplink')
    expect(alertTitle({ name: '  ', metric: 'packetLoss', threshold: 5 })).toBe('Packet loss above 5%')
    expect(alertTitle({ metric: 'packetLoss', threshold: 5 })).toBe('Packet loss above 5%')
  })
})

describe('discordPayload', () => {
  it('posts a firing alert as one red embed', () => {
    const payload = discordPayload(event())

    expect(payload.embeds).toHaveLength(1)
    const [embed] = payload.embeds
    expect(embed.title).toBe('Router: packet loss is too high')
    expect(embed.description).toBe('**Packet loss above 5%** for 3 probes in a row.')
    expect(embed.color).toBe(0xe5484d)
    expect(embed.timestamp).toBe('2026-08-19T22:41:43.911Z')
    expect(embed.fields).toEqual([
      { name: 'Address', value: '192.0.2.1', inline: true },
      { name: 'Now', value: '42.5%', inline: true },
      { name: 'Alert', value: 'Packet loss above 5%', inline: true },
      { name: 'Group', value: 'Home / Network', inline: true },
    ])
  })

  it('mentions the roles and users in the message, where Discord will notify them', () => {
    const payload = discordPayload(event())
    expect(payload.content).toBe(`<@&${ROLE}> <@${USER}>`)
    expect(payload.allowed_mentions).toEqual({ parse: [], roles: [ROLE], users: [USER] })
  })

  it('lets nothing else in the message ping anyone', () => {
    // A target named to cause trouble is only ever text: `parse` is empty, so
    // Discord resolves no mention it was not given by id.
    const payload = discordPayload(event({ targetName: '@everyone' }, { mentionRoleIds: [], mentionUserIds: [] }))
    expect(payload.content).toBeUndefined()
    expect(payload.allowed_mentions).toEqual({ parse: [], roles: [], users: [] })
  })

  it('posts a recovery in green and mentions nobody', () => {
    const payload = discordPayload(event({ transition: 'resolved', observed: 0 }))
    const [embed] = payload.embeds

    expect(embed.title).toBe('Router has recovered')
    expect(embed.description).toBe('**Packet loss above 5%** has been clear for 3 probes in a row.')
    expect(embed.color).toBe(0x30a46c)
    expect(payload.content).toBeUndefined()
    expect(payload.allowed_mentions).toEqual({ parse: [], roles: [], users: [] })
  })

  it('says what a target that is down is doing, not a number', () => {
    const payload = discordPayload(
      event({ metric: 'unreachable', observed: 1 }, { metric: 'unreachable', threshold: 0, consecutiveProbes: 1 })
    )
    const [embed] = payload.embeds
    expect(embed.title).toBe('Router is not responding')
    expect(embed.description).toBe('**Stops responding** on the latest probe.')
    expect(embed.fields[1]).toEqual({ name: 'Now', value: 'No reply', inline: true })
  })

  it('uses the name of a named alert, and leaves out a group the target does not have', () => {
    const payload = discordPayload(event({ targetGroup: undefined }, { name: 'Uplink' }))
    expect(payload.embeds[0].fields.map(field => field.name)).toEqual(['Address', 'Now', 'Alert'])
    expect(payload.embeds[0].fields[2].value).toBe('Uplink')
  })

  it('keeps within the lengths Discord accepts', () => {
    const payload = discordPayload(event({ targetName: 'x'.repeat(400), targetHost: 'h'.repeat(2000) }))
    expect(payload.embeds[0].title.length).toBeLessThanOrEqual(256)
    expect(payload.embeds[0].fields[0].value.length).toBeLessThanOrEqual(1024)
  })

  it('marks a test as a test', () => {
    expect(discordPayload(event(), { test: true }).embeds[0].title).toBe('Test: Router: packet loss is too high')
  })
})

describe('webhookPayload', () => {
  it('keeps the fields earlier versions sent, and adds the alert and the group', () => {
    expect(webhookPayload(event({ observed: 42.5 }))).toEqual({
      status: 'firing',
      alert: { id: 'alert-1', name: 'Packet loss above 5%' },
      target: { name: 'Router', host: '192.0.2.1', group: 'Home/Network' },
      metric: 'packetLoss',
      observed: 42.5,
      threshold: 5,
      at: '2026-08-19T22:41:43.911Z',
      text: 'Router (192.0.2.1): packetLoss is 42.5, past threshold 5',
    })
  })
})

describe('payloadFor', () => {
  it('goes by the destination the alert was given, not by its URL', () => {
    expect(payloadFor(event())).toHaveProperty('embeds')
    expect(payloadFor(event({}, { destination: 'webhook' }))).toHaveProperty('text')
    // A relay that takes Discord's format is sent Discord's format.
    expect(payloadFor(event({}, { destination: 'discord', webhookUrl: 'https://relay.example.com/x' })))
      .toHaveProperty('embeds')
  })
})
