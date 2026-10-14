import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareVersions, currentBuild, isUpdateAvailable, parseImage, publishedImage, type Build } from './version'

const released = (version: string, commit = 'aaaaaaa'): Build => ({
  version,
  commit,
  builtAt: null,
  image: 'ghcr.io/owner/repo',
  development: false,
})

describe('compareVersions', () => {
  it.each([
    ['0.1.10', '0.1.9', 1],
    ['0.2.0', '0.1.99', 1],
    ['1.0.0', '1.0.0', 0],
    ['v0.1.3', '0.1.4', -1],
  ])('%s against %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b)!)).toBe(sign)
  })

  it('will not order a version it cannot read', () => {
    expect(compareVersions('main', '0.1.0')).toBeNull()
    expect(compareVersions('0.1.0-dev.abc1234', '0.1.0')).toBeNull()
  })
})

describe('isUpdateAvailable', () => {
  it('says so when the published version is newer', () => {
    expect(isUpdateAvailable(released('0.1.3'), { version: '0.1.4', commit: 'b', builtAt: null, source: null })).toBe(true)
  })

  it('is up to date on the same version, or on a newer one than published', () => {
    expect(isUpdateAvailable(released('0.1.4'), { version: '0.1.4', commit: 'b', builtAt: null, source: null })).toBe(false)
    expect(isUpdateAvailable(released('0.1.5'), { version: '0.1.4', commit: 'b', builtAt: null, source: null })).toBe(false)
  })

  it('goes by commit when the published image has no version number', () => {
    const before = { version: null, commit: 'bbbbbbb', builtAt: null, source: null }
    expect(isUpdateAvailable(released('0.1.0', 'aaaaaaa'), before)).toBe(true)
    expect(isUpdateAvailable(released('0.1.0', 'bbbbbbb'), before)).toBe(false)
  })

  it('cannot say for a development build', () => {
    const dev = { ...released('0.1.0-dev'), development: true }
    expect(isUpdateAvailable(dev, { version: '9.9.9', commit: 'b', builtAt: null, source: null })).toBeNull()
  })
})

describe('currentBuild', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('reads the build CI baked into the image', () => {
    vi.stubEnv('CLEARPING_VERSION', '0.1.7')
    vi.stubEnv('CLEARPING_COMMIT', 'abc')
    vi.stubEnv('CLEARPING_IMAGE', 'ghcr.io/owner/repo')
    expect(currentBuild()).toMatchObject({ version: '0.1.7', commit: 'abc', image: 'ghcr.io/owner/repo', development: false })
  })

  it('calls a build without a version a development build', () => {
    vi.stubEnv('CLEARPING_VERSION', '')
    expect(currentBuild()).toMatchObject({ development: true, version: expect.stringMatching(/-dev$/) })
  })
})

describe('parseImage', () => {
  it('splits a registry from its repository, in lower case', () => {
    expect(parseImage('ghcr.io/AdamG100/clear-ping')).toEqual({ registry: 'ghcr.io', repository: 'adamg100/clear-ping' })
  })

  it('refuses a name with no registry in front', () => {
    expect(parseImage('clearping')).toBeNull()
  })
})

describe('publishedImage', () => {
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

  it('follows the token challenge and reads the version from the image', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url)
      const authorised = (init?.headers as Record<string, string> | undefined)?.Authorization === 'Bearer t0k'
      if (href.startsWith('https://ghcr.io/token')) {
        expect(href).toContain('scope=repository%3Aowner%2Frepo%3Apull')
        return json({ token: 't0k' })
      }
      if (!authorised) {
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:owner/repo:pull"' },
        })
      }
      if (href.endsWith('/manifests/latest')) {
        return json({
          manifests: [
            { digest: 'sha256:attest', platform: { os: 'unknown', architecture: 'unknown' } },
            { digest: 'sha256:amd64', platform: { os: 'linux', architecture: 'amd64' } },
          ],
        })
      }
      if (href.endsWith('/manifests/sha256:amd64')) return json({ config: { digest: 'sha256:config' } })
      if (href.endsWith('/blobs/sha256:config')) {
        return json({
          config: {
            Env: ['PATH=/usr/bin', 'CLEARPING_VERSION=0.1.9', 'CLEARPING_COMMIT=deadbeef', 'CLEARPING_BUILT_AT=2026-10-14T08:00:00Z'],
            Labels: { 'org.opencontainers.image.source': 'https://github.com/owner/repo' },
          },
        })
      }
      throw new Error(`unexpected ${href}`)
    })

    await expect(publishedImage('ghcr.io/owner/repo', 'latest', fetchFn as typeof fetch)).resolves.toEqual({
      version: '0.1.9',
      commit: 'deadbeef',
      builtAt: '2026-10-14T08:00:00Z',
      source: 'https://github.com/owner/repo',
    })
  })

  it('falls back to the labels for an image built before versions were numbered', async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/manifests/latest')) return json({ config: { digest: 'sha256:config' } })
      return json({
        config: {
          Env: ['CLEARPING_VERSION='],
          Labels: { 'org.opencontainers.image.revision': 'cafe', 'org.opencontainers.image.created': '2026-10-14T07:59:19Z' },
        },
      })
    })

    await expect(publishedImage('ghcr.io/owner/repo', 'latest', fetchFn as typeof fetch)).resolves.toMatchObject({
      version: null,
      commit: 'cafe',
      builtAt: '2026-10-14T07:59:19Z',
    })
  })

  it('says why when the image cannot be read', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 404 }))
    await expect(publishedImage('ghcr.io/owner/repo', 'latest', fetchFn as typeof fetch)).rejects.toThrow('HTTP 404')
  })
})
