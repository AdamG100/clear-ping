import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleMessage, isRequest, JSON_RPC, originAllowed, tokenTravelsSafely, ToolError, type McpServer } from './mcp-protocol'

const server: McpServer = {
  name: 'test',
  title: 'Test server',
  version: '1.2.3',
  instructions: 'Read the tools.',
  tools: [
    {
      name: 'echo',
      title: 'Echo',
      description: 'Says back what it was given.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      run: async args => ({ said: args.text ?? null }),
    },
    {
      name: 'picky',
      title: 'Picky',
      description: 'Refuses.',
      inputSchema: { type: 'object' },
      run: async () => {
        throw new ToolError('There is no target called Routr.')
      },
    },
    {
      name: 'broken',
      title: 'Broken',
      description: 'Falls over.',
      inputSchema: { type: 'object' },
      run: async () => {
        throw new Error('SQLITE_BUSY: the secret path /data/clearping.db')
      },
    },
  ],
  prompts: [
    {
      name: 'report',
      title: 'Report',
      description: 'Writes a report.',
      arguments: [{ name: 'days', description: 'How many days.' }, { name: 'for', description: 'Who for.', required: true }],
      render: args => `A report of ${args.days ?? 7} days for ${args.for}.`,
    },
  ],
}

const ask = (method: string, params?: unknown, id: number | string = 1) => handleMessage(server, { jsonrpc: '2.0', id, method, params })

afterEach(() => vi.restoreAllMocks())

describe('connecting', () => {
  it('answers with the revision the client asked for, where it is one this speaks', async () => {
    const answered = await ask('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } })

    expect(answered).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'test', title: 'Test server', version: '1.2.3' },
        instructions: 'Read the tools.',
      },
    })
  })

  it('offers its newest where the client asked for one it does not speak', async () => {
    const newer = await ask('initialize', { protocolVersion: '2099-01-01' })
    expect(newer?.result).toMatchObject({ protocolVersion: '2025-06-18' })
    expect((await ask('initialize'))?.result).toMatchObject({ protocolVersion: '2025-06-18' })
  })

  it('answers a ping, with the id it was asked under', async () => {
    expect(await ask('ping', undefined, 'abc')).toEqual({ jsonrpc: '2.0', id: 'abc', result: {} })
  })

  it('has nothing to say back to a notification, or to an answer to something it never asked', async () => {
    expect(await handleMessage(server, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await handleMessage(server, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } })).toBeNull()
    expect(await handleMessage(server, { jsonrpc: '2.0', id: 9, result: {} })).toBeNull()
  })

  it('refuses what is not a message, and a method it does not have', async () => {
    expect((await handleMessage(server, 'hello'))?.error?.code).toBe(JSON_RPC.invalidRequest)
    expect((await handleMessage(server, { id: 1, method: 'ping' }))?.error?.code).toBe(JSON_RPC.invalidRequest)
    expect((await handleMessage(server, { jsonrpc: '2.0', id: 1 }))?.error?.code).toBe(JSON_RPC.invalidRequest)
    expect(await ask('resources/list')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: JSON_RPC.methodNotFound, message: 'Method not found: resources/list' },
    })
  })

  it('tells a request from a notification by its id', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 0, method: 'ping' })).toBe(true)
    expect(isRequest({ jsonrpc: '2.0', method: 'ping' })).toBe(false)
    expect(isRequest({ jsonrpc: '2.0', id: null, method: 'ping' })).toBe(false)
  })
})

describe('tools', () => {
  it('lists them with what each takes, marked as only reading', async () => {
    const listed = (await ask('tools/list'))?.result as { tools: Array<Record<string, unknown>> }

    expect(listed.tools.map(tool => tool.name)).toEqual(['echo', 'picky', 'broken'])
    expect(listed.tools[0]).toEqual({
      name: 'echo',
      title: 'Echo',
      description: 'Says back what it was given.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      annotations: { title: 'Echo', readOnlyHint: true, openWorldHint: false },
    })
    // What a tool does is not part of what is said about it.
    expect(listed.tools[0]).not.toHaveProperty('run')
  })

  it('runs one and hands back what it returned, as text', async () => {
    expect((await ask('tools/call', { name: 'echo', arguments: { text: 'hi' } }))?.result).toEqual({
      content: [{ type: 'text', text: '{"said":"hi"}' }],
    })
    // No arguments at all is no arguments, not a fault.
    expect((await ask('tools/call', { name: 'echo' }))?.result).toEqual({ content: [{ type: 'text', text: '{"said":null}' }] })
  })

  it('passes on what a tool says is wrong with the request, as its result', async () => {
    expect((await ask('tools/call', { name: 'picky' }))?.result).toEqual({
      content: [{ type: 'text', text: 'There is no target called Routr.' }],
      isError: true,
    })
  })

  it('does not pass on a fault of its own', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = (await ask('tools/call', { name: 'broken' }))?.result as { content: Array<{ text: string }>; isError: boolean }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).not.toContain('SQLITE')
    expect(result.content[0].text).not.toContain('/data')
    expect(logged).toHaveBeenCalled()
  })

  it('refuses a tool it does not have', async () => {
    expect((await ask('tools/call', { name: 'delete_everything' }))?.error).toEqual({
      code: JSON_RPC.invalidParams,
      message: 'Unknown tool: delete_everything',
    })
    expect((await ask('tools/call', {}))?.error?.code).toBe(JSON_RPC.invalidParams)
  })
})

describe('tools that change something', () => {
  const writing: McpServer = {
    ...server,
    writeInstructions: 'You may also add targets.',
    tools: [
      ...server.tools,
      {
        name: 'add_thing',
        title: 'Add a thing',
        description: 'Adds.',
        inputSchema: { type: 'object' },
        writes: true,
        run: async () => ({ added: true }),
      },
    ],
  }
  const asked = (method: string, params: unknown, writes: boolean) =>
    handleMessage(writing, { jsonrpc: '2.0', id: 1, method, params }, { writes })
  const names = async (writes: boolean) =>
    ((await asked('tools/list', undefined, writes))?.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)

  it('are not on the list for a connection that may only read', async () => {
    expect(await names(false)).toEqual(['echo', 'picky', 'broken'])
    expect(await names(true)).toEqual(['echo', 'picky', 'broken', 'add_thing'])
    // And only reading is what a connection gets unless it is said otherwise.
    expect(((await handleMessage(writing, { jsonrpc: '2.0', id: 1, method: 'tools/list' }))?.result as { tools: unknown[] }).tools).toHaveLength(3)
  })

  it('are marked as changing something, and as not destroying anything', async () => {
    const listed = (await asked('tools/list', undefined, true))?.result as { tools: Array<{ name: string; annotations: unknown }> }
    expect(listed.tools.find(tool => tool.name === 'add_thing')?.annotations).toEqual({
      title: 'Add a thing',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    })
    expect(listed.tools.find(tool => tool.name === 'echo')?.annotations).toMatchObject({ readOnlyHint: true })
  })

  it('are refused in words when asked for by name all the same, and run when allowed', async () => {
    const refused = (await asked('tools/call', { name: 'add_thing' }, false))?.result as { content: Array<{ text: string }>; isError: boolean }
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('this connection may only read')
    expect(refused.content[0].text).toContain('CLEARPING_MCP_TOKEN')

    expect((await asked('tools/call', { name: 'add_thing' }, true))?.result).toEqual({ content: [{ type: 'text', text: '{"added":true}' }] })
    // One that only reads is there either way.
    expect((await asked('tools/call', { name: 'echo', arguments: { text: 'x' } }, false))?.result).toMatchObject({ content: [{ text: '{"said":"x"}' }] })
  })

  it('are told about when connecting only to a connection that has them', async () => {
    const instructions = async (writes: boolean) => ((await asked('initialize', {}, writes))?.result as { instructions: string }).instructions
    expect(await instructions(false)).toBe('Read the tools.')
    expect(await instructions(true)).toBe('Read the tools. You may also add targets.')
  })
})

describe('tokenTravelsSafely', () => {
  it('takes a token over HTTPS from anywhere', () => {
    expect(tokenTravelsSafely('https', 'clearping.example.com')).toBe(true)
    // Two proxies, one behind the other: the first is what the client used.
    expect(tokenTravelsSafely('https, http', '203.0.113.5')).toBe(true)
    expect(tokenTravelsSafely('HTTPS', 'clearping.example.com')).toBe(true)
  })

  it('takes one over plain HTTP only at an address on the client’s own network', () => {
    expect(tokenTravelsSafely('http', 'localhost:3000')).toBe(true)
    expect(tokenTravelsSafely('http', '192.168.1.20:3000')).toBe(true)
    expect(tokenTravelsSafely('http', 'clearping.lan')).toBe(true)
    expect(tokenTravelsSafely(null, '[::1]:3000')).toBe(true)
  })

  it('refuses one sent in the clear across the internet', () => {
    expect(tokenTravelsSafely('http', 'clearping.example.com')).toBe(false)
    expect(tokenTravelsSafely('http', '203.0.113.5:3000')).toBe(false)
    expect(tokenTravelsSafely('http, https', 'clearping.example.com')).toBe(false)
    expect(tokenTravelsSafely(null, 'clearping.example.com')).toBe(false)
    expect(tokenTravelsSafely('http', null)).toBe(false)
  })

  it('can be told that something else encrypts it', () => {
    expect(tokenTravelsSafely('http', 'clearping.example.com', true)).toBe(true)
  })
})

describe('prompts', () => {
  it('lists them with their arguments', async () => {
    expect((await ask('prompts/list'))?.result).toEqual({
      prompts: [
        {
          name: 'report',
          title: 'Report',
          description: 'Writes a report.',
          arguments: [{ name: 'days', description: 'How many days.' }, { name: 'for', description: 'Who for.', required: true }],
        },
      ],
    })
  })

  it('writes one out as the request it stands for', async () => {
    expect((await ask('prompts/get', { name: 'report', arguments: { days: '14', for: 'Acme' } }))?.result).toEqual({
      description: 'Writes a report.',
      messages: [{ role: 'user', content: { type: 'text', text: 'A report of 14 days for Acme.' } }],
    })
  })

  it('refuses one it does not have, or one left without what it needs', async () => {
    expect((await ask('prompts/get', { name: 'nope' }))?.error?.code).toBe(JSON_RPC.invalidParams)
    expect((await ask('prompts/get', { name: 'report', arguments: { days: '3' } }))?.error?.message).toBe('report needs for')
  })
})

describe('originAllowed', () => {
  it('lets through a program that is not a browser, which sends no origin', () => {
    expect(originAllowed(null, 'clearping.lan:3000')).toBe(true)
  })

  it('lets a page through only from the address ClearPing itself was reached at', () => {
    expect(originAllowed('http://clearping.lan:3000', 'clearping.lan:3000')).toBe(true)
    expect(originAllowed('http://CLEARPING.lan:3000', 'clearping.lan:3000')).toBe(true)
    // Another website, making the visitor's browser reach into their network.
    expect(originAllowed('https://evil.example', 'clearping.lan:3000')).toBe(false)
    expect(originAllowed('http://clearping.lan:8080', 'clearping.lan:3000')).toBe(false)
    expect(originAllowed('null', 'clearping.lan:3000')).toBe(false)
    expect(originAllowed('http://clearping.lan:3000', null)).toBe(false)
  })
})
