import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-mcp-route-'))
process.env.CLEARPING_DB_PATH = path.join(dir, 'test.db')
process.env.CLEARPING_EXTERNAL_PROBER = '1'

const { initDatabase, closeDatabase } = await import('@/lib/db/database')
const { closeAuth } = await import('@/lib/security/auth')
const { POST } = await import('./route')

const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' })

function send(body: unknown) {
  return POST(
    new NextRequest('http://localhost:3000/api/mcp', {
      method: 'POST',
      headers: { host: 'localhost:3000', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    })
  )
}

beforeAll(async () => {
  await initDatabase()
})

afterAll(async () => {
  closeAuth()
  await closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('several messages sent as a list', () => {
  it('are answered up to the limit', async () => {
    const answer = await send(Array.from({ length: 20 }, (_, i) => ping(i)))
    expect(answer.status).toBe(200)
    expect(await answer.json()).toHaveLength(20)
  })

  it('are refused past it, with none of them run', async () => {
    const answer = await send(Array.from({ length: 21 }, (_, i) => ping(i)))
    expect(answer.status).toBe(400)
    expect((await answer.json()).error.message).toContain('at most 20')
  })
})
