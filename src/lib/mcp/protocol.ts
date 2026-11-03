/**
 * The Model Context Protocol, as much of it as a server of read-only tools
 * needs: an assistant connects, asks what tools there are, and calls them.
 *
 * It is JSON-RPC over HTTP, one message to a request and one answer to each,
 * with nothing kept between them. That is small enough to write out here,
 * where it can be read and tested, which is why there is no SDK behind it:
 * the app has one process and few dependencies, and this is not a reason to
 * add to either.
 *
 * Pure: what the tools do is handed in. How a message arrives is the route's.
 */

import { isLocalHost } from '../probes/host'

/** The revisions of the protocol this speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

/** What a client is taken to speak when it does not say, as the specification has it. */
export const MCP_DEFAULT_VERSION = '2025-03-26'

export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

type JsonRpcId = string | number

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * Something wrong with what a tool was asked, to be told to the assistant in
 * words it can act on: "No target called Routr. There is: Router, Gateway."
 * Anything else a tool throws is a fault of ours and is not passed on.
 */
export class ToolError extends Error {}

export interface McpTool {
  name: string
  /** What it is called where a person reads the list. */
  title: string
  /** What it is for and when to reach for it: this is all the assistant has to choose by. */
  description: string
  /** JSON Schema of its arguments. */
  inputSchema: Record<string, unknown>
  /**
   * Set on a tool that changes something. Such a tool is neither offered nor
   * run unless the connection is allowed to write.
   */
  writes?: boolean
  run: (args: Record<string, unknown>) => Promise<unknown>
}

/** What one connection is allowed, decided by the route from how it arrived. */
export interface McpAccess {
  /** Whether the tools that change something are there for it. */
  writes: boolean
  /** Told of every call to a tool that changes something, after it has run: for the record of who did what. */
  onWrite?: (tool: string, args: Record<string, unknown>, failed: boolean) => Promise<void> | void
}

export interface McpPrompt {
  name: string
  title: string
  description: string
  arguments: Array<{ name: string; description: string; required?: boolean }>
  /** The request it stands for, written out. */
  render: (args: Record<string, string>) => string
}

export interface McpServer {
  name: string
  title: string
  version: string
  /** Said once to an assistant when it connects: what this is, and how to read what it returns. */
  instructions: string
  /** Said after it to a connection that is allowed to write: what it may change, and what it may not. */
  writeInstructions?: string
  tools: McpTool[]
  prompts: McpPrompt[]
}

/** What it takes for a connection to be allowed to change anything. */
export const WRITES_NEED =
  'An assistant can add and change monitors only with a key that may change things: one is made in ClearPing\'s Settings → Keys, by an account that may change things, and sent as "Authorization: Bearer <key>".'

const answer = (id: JsonRpcId | null, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })
const refuse = (id: JsonRpcId | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether a message is one that is answered: a request has an id, a notification has none. */
export function isRequest(message: unknown): boolean {
  return isObject(message) && typeof message.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number')
}

async function callTool(tool: McpTool, args: unknown) {
  try {
    const result = await tool.run(isObject(args) ? args : {})
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] }
  } catch (error) {
    // A tool that could not do what was asked says so as its result, which
    // the assistant reads and can put right; that is not a protocol error.
    if (error instanceof ToolError) return { content: [{ type: 'text', text: error.message }], isError: true }
    console.error(`[MCP] ${tool.name} failed:`, error)
    return { content: [{ type: 'text', text: `${tool.name} failed inside ClearPing. Its log has the reason.` }], isError: true }
  }
}

/**
 * Answer one message. Null for a notification, or for a response to something
 * this never asked: neither is answered.
 */
export async function handleMessage(
  server: McpServer,
  message: unknown,
  access: McpAccess = { writes: false }
): Promise<JsonRpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== '2.0') {
    return refuse(null, JSON_RPC.invalidRequest, 'Not a JSON-RPC 2.0 message')
  }
  if (typeof message.method !== 'string') {
    // A response, to a request that was never made.
    return 'result' in message || 'error' in message ? null : refuse(null, JSON_RPC.invalidRequest, 'A message needs a method')
  }
  if (!isRequest(message)) return null

  const id = message.id as JsonRpcId
  const params = isObject(message.params) ? message.params : {}

  switch (message.method) {
    case 'initialize': {
      const asked = params.protocolVersion
      // The client's own revision where it is one of ours, and our newest
      // where it is not, for the client to take or leave.
      const version = MCP_PROTOCOL_VERSIONS.find(each => each === asked) ?? MCP_PROTOCOL_VERSIONS[0]
      return answer(id, {
        protocolVersion: version,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: server.name, title: server.title, version: server.version },
        instructions: access.writes && server.writeInstructions ? `${server.instructions} ${server.writeInstructions}` : server.instructions,
      })
    }

    case 'ping':
      return answer(id, {})

    case 'tools/list':
      return answer(id, {
        // A tool that changes something is not on the list at all for a
        // connection that may only read: there is nothing there to be tried.
        tools: server.tools.filter(tool => access.writes || !tool.writes).map(tool => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          // Said of each, so that a client can ask before running one that
          // changes something and need not for one that only reads. None of
          // them destroys anything: there is no tool here that deletes.
          annotations: tool.writes
            ? { title: tool.title, readOnlyHint: false, destructiveHint: false, openWorldHint: true }
            : { title: tool.title, readOnlyHint: true, openWorldHint: false },
        })),
      })

    case 'tools/call': {
      const tool = server.tools.find(each => each.name === params.name)
      if (!tool) return refuse(id, JSON_RPC.invalidParams, `Unknown tool: ${String(params.name)}`)
      // Asked for by name all the same. Refused as the tool's result, in
      // words, so that the assistant can tell the person why.
      if (tool.writes && !access.writes) {
        return answer(id, {
          content: [{ type: 'text', text: `${tool.name} changes something, and this connection may only read. ${WRITES_NEED}` }],
          isError: true,
        })
      }
      const result = await callTool(tool, params.arguments)
      if (tool.writes) await access.onWrite?.(tool.name, isObject(params.arguments) ? params.arguments : {}, !!result.isError)
      return answer(id, result)
    }

    case 'prompts/list':
      return answer(id, {
        prompts: server.prompts.map(prompt => ({
          name: prompt.name,
          title: prompt.title,
          description: prompt.description,
          arguments: prompt.arguments,
        })),
      })

    case 'prompts/get': {
      const prompt = server.prompts.find(each => each.name === params.name)
      if (!prompt) return refuse(id, JSON_RPC.invalidParams, `Unknown prompt: ${String(params.name)}`)

      const given = isObject(params.arguments) ? params.arguments : {}
      const args = Object.fromEntries(
        Object.entries(given).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
      const missing = prompt.arguments.find(argument => argument.required && !args[argument.name])
      if (missing) return refuse(id, JSON_RPC.invalidParams, `${prompt.name} needs ${missing.name}`)

      return answer(id, {
        description: prompt.description,
        messages: [{ role: 'user', content: { type: 'text', text: prompt.render(args) } }],
      })
    }

    default:
      return refuse(id, JSON_RPC.methodNotFound, `Method not found: ${message.method}`)
  }
}

/**
 * Whether a browser page is allowed to talk to this. A program that is not a
 * browser sends no Origin and is let through. A page is let through only from
 * the address ClearPing itself was reached at: any other is a website making
 * the visitor's browser reach into their network, which is how a server on a
 * private address gets read by a stranger. The websites an admin lists under
 * Settings → Access (`allowed`) are let through as well.
 */
export function originAllowed(origin: string | null, host: string | null, allowed: readonly string[] = []): boolean {
  if (!origin) return true
  if (allowed.includes(origin)) return true
  try {
    return !!host && new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Whether a request that carries the token arrived in a way that kept the
 * token to itself.
 *
 * A token sent over plain HTTP across the internet can be read by anything on
 * the way, and whoever reads it can change what is monitored. So it is taken
 * only over HTTPS, or at an address on the client's own network, where there
 * is no internet in between: this machine, a private address, a local name.
 *
 * `proto` is what the request came in over as the server or the proxy in
 * front of it has it (`x-forwarded-proto`), and `host` what the client wrote
 * to reach it. Neither can be trusted against an attacker, and neither needs
 * to be: this is not what keeps a stranger out, the token is. It is what
 * stops an honest setup from sending its token in the clear without knowing.
 */
export function tokenTravelsSafely(proto: string | null, host: string | null, allowPlainHttp = false): boolean {
  if (allowPlainHttp) return true
  // A proxy that was itself behind a proxy lists both; the first is the client's.
  if ((proto ?? '').split(',')[0].trim().toLowerCase() === 'https') return true
  return !!host && isLocalHost(host)
}
