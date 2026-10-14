import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Passwords, and the random tokens that sessions and keys are made of.
 *
 * A password is something a person chose, so it is hashed slowly (scrypt,
 * with a salt of its own) to make guessing from a stolen copy expensive. A
 * session or key is 32 random bytes nobody chose, which no amount of guessing
 * gets near, so a plain SHA-256 of it is enough and lets it be looked up by
 * its hash in one query.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, params.keylen, { N: params.N, r: params.r, p: params.p }, (error, key) =>
      error ? reject(error) : resolve(key)
    )
  })
}

/** `scrypt$N$r$p$salt$hash`, with the settings kept beside the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, SCRYPT)
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64url')
  const key = await derive(password, Buffer.from(salt, 'base64url'), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    keylen: expected.length,
  })
  return timingSafeEqual(key, expected)
}

/**
 * A hash to check against when there is no such user, so that a wrong
 * username takes as long to refuse as a wrong password and says nothing about
 * which names exist.
 */
let decoy: Promise<string> | null = null
export function decoyHash(): Promise<string> {
  return (decoy ??= hashPassword(randomBytes(16).toString('hex')))
}

export const MIN_PASSWORD_LENGTH = 10

/** Why a password will not do, or null if it will. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `A password needs at least ${MIN_PASSWORD_LENGTH} characters`
  }
  if (password.length > 1024) return 'That password is too long'
  return null
}

/** What a key looks like: `cp_` and 43 characters, so it can be recognised wherever it ends up. */
export const KEY_PREFIX = 'cp_'

export function newToken(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url')
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Compare two secrets in the same time whether or not they match. */
export function sameSecret(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}
