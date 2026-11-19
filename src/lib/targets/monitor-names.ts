import { NextRequest, NextResponse } from 'next/server'

// What the dashboard calls a monitor was called a *target* in the API's JSON
// and the MCP tools, and still is inside ClearPing: in the code, the database,
// the probe agent protocol and the export file. The API and the tools now
// speak of monitors, and still take the old names, so a script or an assistant
// written against them keeps working.

/** A JSON key that names a target (`target`, `targetIds`, `reachedTheDestination`), never a map key such as an id. */
const TARGET_KEY = /^(target|[a-zA-Z]*Target)[a-zA-Z]*$/

/** A key a caller may send with the new names, and the old name it stands for. */
const MONITOR_KEY = /^monitor(s|Id|Ids|Name|Group)?$/

type Json = unknown

const isPlainObject = (value: Json): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `targetIds` → `monitorIds`. */
export function monitorKeyOf(key: string): string {
  return TARGET_KEY.test(key) ? key.replace(/target/g, 'monitor').replace(/Target/g, 'Monitor') : key
}

/** `monitorIds` → `targetIds`, for what a caller sends. */
export function targetKeyOf(key: string): string {
  return MONITOR_KEY.test(key) ? key.replace('monitor', 'target') : key
}

/** The same JSON with every target key named for monitors. */
export function withMonitorKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(withMonitorKeys)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, each]) => [monitorKeyOf(key), withMonitorKeys(each)]))
}

/** The same JSON with every target key kept, and a monitor-named copy of it beside it. */
export function withBothKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(withBothKeys)
  if (!isPlainObject(value)) return value
  const out: Record<string, Json> = {}
  for (const [key, each] of Object.entries(value)) {
    out[key] = withBothKeys(each)
    const renamed = monitorKeyOf(key)
    if (renamed !== key && !(renamed in value)) out[renamed] = withMonitorKeys(each)
  }
  return out
}

/** What a caller sent with monitor names, as the target names the code reads. An old name sent as well wins. */
export function withTargetKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(withTargetKeys)
  if (!isPlainObject(value)) return value
  const out: Record<string, Json> = {}
  for (const [key, each] of Object.entries(value)) {
    const old = targetKeyOf(key)
    if (old !== key && old in value) continue
    out[old] = withTargetKeys(each)
  }
  return out
}

type Handler<Context> = (request: NextRequest, context: Context) => Promise<Response>

/** The request with monitor names in its query and JSON body turned into the target names the handler reads. */
async function translatedRequest(request: NextRequest): Promise<NextRequest> {
  const url = new URL(request.url)
  for (const [key, value] of [...url.searchParams]) {
    const old = targetKeyOf(key)
    if (old === key) continue
    url.searchParams.delete(key)
    if (!url.searchParams.has(old)) url.searchParams.set(old, value)
  }

  if (request.body === null) {
    return url.href === request.url ? request : new NextRequest(url, { method: request.method, headers: request.headers })
  }

  let body = await request.text()
  if ((request.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      body = JSON.stringify(withTargetKeys(JSON.parse(body)))
    } catch {
      // Not JSON after all: the handler says what is wrong with it.
    }
  }
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  return new NextRequest(url, { method: request.method, headers, body })
}

/** The response with its JSON rewritten, its status and headers kept. */
async function translatedResponse(response: Response, rewrite: (value: Json) => Json): Promise<Response> {
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return response
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return NextResponse.json(rewrite(await response.json()), { status: response.status, headers })
}

/**
 * An `/api/monitors/…` route: the `/api/targets/…` handler it stands for, taking
 * and giving monitor names. `/api/targets/…` itself is left exactly as it was.
 */
export function monitorRoute<Context>(handler: Handler<Context>): Handler<Context> {
  return async (request, context) => translatedResponse(await handler(await translatedRequest(request), context), withMonitorKeys)
}

/**
 * A route that has always been at the same address (alerts, compare, …): it
 * takes either name, and answers with both, the old key and a monitor-named
 * copy beside it.
 */
export function eitherNames<Context>(handler: Handler<Context>): Handler<Context> {
  return async (request, context) => translatedResponse(await handler(await translatedRequest(request), context), withBothKeys)
}
