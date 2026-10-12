import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { checkNotifyUrls, readAppriseLog, sendNotification } from './apprise'

const configured = process.env.CLEARPING_APPRISE_BIN
const installed = spawnSync(configured || 'apprise', ['--version']).status === 0

afterEach(() => {
  if (configured === undefined) delete process.env.CLEARPING_APPRISE_BIN
  else process.env.CLEARPING_APPRISE_BIN = configured
})

describe('readAppriseLog', () => {
  it('reads each line of the log, without its timestamp', () => {
    const output = [
      '2026-10-12 23:48:18,266 - ERROR - Unparseable URL pigeon://coop',
      '2026-10-12 23:48:20,301 - WARNING - A Connection error occurred sending JSON notification to 127.0.0.1.',
      '',
    ].join('\r\n')

    expect(readAppriseLog(output)).toEqual([
      { level: 'ERROR', message: 'Unparseable URL pigeon://coop' },
      { level: 'WARNING', message: 'A Connection error occurred sending JSON notification to 127.0.0.1.' },
    ])
  })

  it('leaves out what is not the log', () => {
    const output = [
      'You must specify at least one service URL or populated configuration file.',
      "Try 'apprise --help' for more information.",
      '   1. json://127.0.0.1:8765/ok?method=POST',
      '       uid: 6e1f9ffd',
    ].join('\n')

    expect(readAppriseLog(output)).toEqual([])
  })
})

describe('without Apprise installed', () => {
  const notification = { title: 'Router is not responding', body: '<p>Down.</p>', type: 'failure' as const }

  it('says so, and how to put it right, rather than failing in silence', async () => {
    process.env.CLEARPING_APPRISE_BIN = '/nowhere/apprise-is-not-here'

    const result = await sendNotification(['json://127.0.0.1:1/x'], notification)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('pip install apprise')
    expect(result.detail).toContain('CLEARPING_APPRISE_BIN')
  })

  it('still lets an alert be saved, having nothing to check its URLs with', async () => {
    process.env.CLEARPING_APPRISE_BIN = '/nowhere/apprise-is-not-here'
    expect(await checkNotifyUrls(['pigeon://coop'])).toEqual({ ok: true })
  })
})

/**
 * The real program, sending to a server on this machine. Skipped where Apprise
 * is not installed; CLEARPING_APPRISE_BIN points these at one that is not on
 * the PATH.
 */
describe.skipIf(!installed)('with Apprise installed', () => {
  interface Received {
    path: string
    body: { title: string; message: string; type: string }
  }

  const received: Received[] = []
  let server: http.Server
  let base: string

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () => {
        received.push({ path: req.url ?? '', body: JSON.parse(body) })
        res.writeHead(200)
        res.end('ok')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `json://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  const notification = {
    title: 'Tést: Router <1> & co is not responding',
    body: '<p><b>Stops responding</b> for 3 probes in a row.</p><ul><li><b>Address:</b> a&amp;b.example</li></ul>',
    type: 'failure' as const,
  }

  it('sends the title, the type and the body, in the format the URL asks for', async () => {
    // A JSON endpoint takes any format, so each URL says which it wants.
    const result = await sendNotification(
      [`${base}/text?format=text`, `${base}/markdown?format=markdown`, `${base}/html`],
      notification
    )
    expect(result).toEqual({ ok: true })

    const sent = Object.fromEntries(received.map(entry => [entry.path, entry.body]))
    expect(sent['/text']).toMatchObject({
      title: 'Tést: Router <1> & co is not responding',
      type: 'failure',
      message: 'Stops responding for 3 probes in a row.\n- Address: a&b.example',
    })
    expect(sent['/markdown'].message).toBe('**Stops responding** for 3 probes in a row.\n\n- **Address:** a&b.example')
    expect(sent['/html'].message).toBe(notification.body)
  }, 30_000)

  it('explains a delivery that failed', async () => {
    const result = await sendNotification(['json://127.0.0.1:1/nobody-listening'], notification)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^Apprise could not deliver it: .+/)
  }, 30_000)

  it('does not call it delivered when one URL of several was no good', async () => {
    const before = received.length
    const result = await sendNotification([`${base}/good`, 'pigeon://coop'], notification)

    expect(received).toHaveLength(before + 1)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^Apprise delivered it to some of the notification URLs but not all: .*pigeon/)
  }, 30_000)

  it('checks URLs without sending anything', async () => {
    const before = received.length

    expect(await checkNotifyUrls([`${base}/check`, 'discord://123456789012345678/abcDEF_token'])).toEqual({ ok: true })
    expect(await checkNotifyUrls([])).toEqual({ ok: true })

    const unknown = await checkNotifyUrls(['pigeon://coop'])
    expect(unknown.ok).toBe(false)
    expect(unknown.detail).toMatch(/^Apprise cannot use the notification URL: .*pigeon/)

    // A web address is only a service where Apprise knows whose it is.
    expect((await checkNotifyUrls(['https://hooks.example.com/x'])).ok).toBe(false)
    const mixed = await checkNotifyUrls([`${base}/check`, 'discord://missing-its-token'])
    expect(mixed.ok).toBe(false)
    expect(mixed.detail).toMatch(/^Apprise cannot use one of the notification URLs: /)

    expect(received).toHaveLength(before)
  }, 30_000)
})
