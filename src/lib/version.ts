import packageJson from '../../package.json'

/**
 * Which build of ClearPing this is, and whether a newer one has been published.
 *
 * Every deployment gets a version number of its own: CI numbers each build of
 * main (scripts/next-version.mjs: the last release plus a patch, or the minor or
 * major a commit asked for in a Release: trailer), bakes it into the image, tags the image and the commit with it, and makes a
 * release of it. This module reads that number back out of the environment
 * the image was built with.
 *
 * "Is this the latest?" is answered by the registry rather than the source
 * repository: the newest version is whatever `:latest` is, because that is
 * what an update would pull. The image is public even where the repository
 * is not, so the question needs no token. Asked at most every quarter of an
 * hour, and turned off with CLEARPING_UPDATE_CHECK=off for an install that
 * should not reach out at all.
 */

export interface Build {
  /** MAJOR.MINOR.PATCH, or the package version marked `-dev` for a build CI did not make. */
  version: string
  commit: string | null
  /** ISO 8601. */
  builtAt: string | null
  /** Where this image is published, e.g. ghcr.io/owner/repo. Where updates are looked for. */
  image: string | null
  /** Not a numbered build: run from source, or built by hand. */
  development: boolean
}

export interface Published {
  version: string | null
  commit: string | null
  builtAt: string | null
  /** The repository's web address, from the image's source label. */
  source: string | null
}

export interface VersionStatus {
  current: Build
  /** Null when not looked for, or when looking failed. */
  latest: Published | null
  /** Null when it cannot be told: not looked, looking failed, or a development build. */
  updateAvailable: boolean | null
  /** Why `latest` is null, in words fit to show. */
  latestUnknownBecause?: string
  checkedAt: string | null
}

const env = (name: string) => process.env[name]?.trim() || null

export function currentBuild(): Build {
  const version = env('CLEARPING_VERSION')
  return {
    version: version ?? `${packageJson.version}-dev`,
    commit: env('CLEARPING_COMMIT'),
    builtAt: env('CLEARPING_BUILT_AT'),
    image: env('CLEARPING_IMAGE'),
    development: version === null,
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/

/** Above zero when `a` is the newer, below when `b` is; null when either is not a plain MAJOR.MINOR.PATCH. */
export function compareVersions(a: string, b: string): number | null {
  const x = SEMVER.exec(a.trim())
  const y = SEMVER.exec(b.trim())
  if (!x || !y) return null
  for (let i = 1; i <= 3; i++) {
    const difference = Number(x[i]) - Number(y[i])
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Whether `latest` is newer than `current`.
 *
 * By version where both have one. An image published before versions were
 * numbered only has a commit, and a different commit on `:latest` then means
 * there is something newer to pull.
 */
export function isUpdateAvailable(current: Build, latest: Published): boolean | null {
  if (current.development) return null
  if (latest.version) {
    const order = compareVersions(latest.version, current.version)
    if (order !== null) return order > 0
  }
  if (latest.commit && current.commit) return latest.commit !== current.commit
  return null
}

// ─── Asking the registry ────────────────────────────────────────────────────

type FetchFn = typeof fetch

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

/** Per request. The whole check is four of them. */
const REQUEST_TIMEOUT_MS = 10_000

interface ImageConfig {
  config?: { Env?: string[]; Labels?: Record<string, string> | null }
  created?: string
}

/** Split `ghcr.io/owner/repo` into the registry and the repository on it. */
export function parseImage(image: string): { registry: string; repository: string } | null {
  const [registry, ...rest] = image.replace(/^https?:\/\//, '').split('/')
  const repository = rest.join('/').toLowerCase()
  if (!registry.includes('.') || !repository) return null
  return { registry, repository }
}

/**
 * Read what the image tagged `tag` was built as: its version, commit and when.
 *
 * The registry API, unauthenticated where the image is public: the first
 * request is refused with directions to a token service, which hands out an
 * anonymous pull token.
 */
export async function publishedImage(image: string, tag = 'latest', fetchFn: FetchFn = fetch): Promise<Published> {
  const where = parseImage(image)
  if (!where) throw new Error(`Not an image name: ${image}`)
  const base = `https://${where.registry}/v2/${where.repository}`
  let token: string | null = null

  const get = async (url: string, accept?: string): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (accept) headers.Accept = accept
    if (token) headers.Authorization = `Bearer ${token}`
    const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

    if (response.status === 401 && !token) {
      token = await anonymousToken(response.headers.get('www-authenticate'), fetchFn)
      return get(url, accept)
    }
    if (!response.ok) throw new Error(`The registry answered HTTP ${response.status}`)
    return response
  }

  let manifest = await (await get(`${base}/manifests/${tag}`, MANIFEST_TYPES)).json()

  // An image for several architectures is a list of them. Their versions are
  // the same, so any one will do; the entries for unknown/unknown are build
  // attestations, not images.
  if (Array.isArray(manifest.manifests)) {
    const one = manifest.manifests.find(
      (entry: { platform?: { os?: string } }) => entry.platform && entry.platform.os !== 'unknown'
    )
    if (!one) throw new Error('The image lists no platform to read')
    manifest = await (await get(`${base}/manifests/${one.digest}`, MANIFEST_TYPES)).json()
  }

  const digest = manifest.config?.digest
  if (typeof digest !== 'string') throw new Error('The image has no configuration to read')
  const config = (await (await get(`${base}/blobs/${digest}`)).json()) as ImageConfig

  const environment = new Map(
    (config.config?.Env ?? []).map(entry => {
      const at = entry.indexOf('=')
      return [entry.slice(0, at), entry.slice(at + 1).trim()] as const
    })
  )
  const labels = config.config?.Labels ?? {}
  const label = (name: string) => labels[`org.opencontainers.image.${name}`]?.trim() || null

  return {
    version: environment.get('CLEARPING_VERSION') || null,
    commit: environment.get('CLEARPING_COMMIT') || label('revision'),
    builtAt: environment.get('CLEARPING_BUILT_AT') || label('created') || config.created || null,
    source: label('source'),
  }
}

/** Follow a registry's `WWW-Authenticate: Bearer realm=…,service=…,scope=…` to an anonymous token. */
async function anonymousToken(challenge: string | null, fetchFn: FetchFn): Promise<string> {
  const fields = new Map([...(challenge ?? '').matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]))
  const realm = fields.get('realm')
  if (!realm || !/^bearer /i.test(challenge ?? '')) throw new Error('The registry asked for credentials')

  const url = new URL(realm)
  for (const key of ['service', 'scope']) {
    const value = fields.get(key)
    if (value) url.searchParams.set(key, value)
  }
  const response = await fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`The registry would not give a token (HTTP ${response.status}); is the image private?`)
  const body = await response.json()
  const token = body.token ?? body.access_token
  if (typeof token !== 'string') throw new Error('The registry gave no token')
  return token
}

// ─── Remembered between requests ────────────────────────────────────────────

const CHECK_EVERY_MS = 15 * 60 * 1000
/** Sooner after a failure: a registry that was briefly unreachable should not hide an update for an hour. */
const RETRY_AFTER_MS = 10 * 60 * 1000

interface Checked {
  at: number
  latest: Published | null
  error?: string
}

const CACHE_KEY = Symbol.for('clearping.version-check')
type CacheGlobal = typeof globalThis & { [CACHE_KEY]?: { checked?: Checked; inFlight?: Promise<Checked> } }

function cache() {
  const store = globalThis as CacheGlobal
  return (store[CACHE_KEY] ??= {})
}

function updateCheckDisabled(): boolean {
  return /^(0|off|false|no)$/i.test(env('CLEARPING_UPDATE_CHECK') ?? '')
}

export async function versionStatus(now = Date.now()): Promise<VersionStatus> {
  const current = currentBuild()
  const unknown = (because: string): VersionStatus => ({
    current,
    latest: null,
    updateAvailable: null,
    latestUnknownBecause: because,
    checkedAt: null,
  })

  if (updateCheckDisabled()) return unknown('Checking for updates is turned off (CLEARPING_UPDATE_CHECK)')
  if (!current.image) return unknown('This build was not published, so there is nowhere to look for updates')
  const image = current.image

  const store = cache()
  const fresh = store.checked && now - store.checked.at < (store.checked.latest ? CHECK_EVERY_MS : RETRY_AFTER_MS)
  if (!fresh) {
    store.inFlight ??= publishedImage(image)
      .then(latest => ({ at: Date.now(), latest }))
      .catch(error => ({ at: Date.now(), latest: null, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { store.inFlight = undefined })
    store.checked = await store.inFlight
  }

  const { latest, error, at } = store.checked!
  if (!latest) return { ...unknown(`Could not reach the registry: ${error ?? 'unknown error'}`), checkedAt: new Date(at).toISOString() }

  return {
    current,
    latest,
    updateAvailable: isUpdateAvailable(current, latest),
    checkedAt: new Date(at).toISOString(),
  }
}
