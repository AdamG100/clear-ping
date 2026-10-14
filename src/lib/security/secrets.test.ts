import { describe, expect, it } from 'vitest'
import { hashPassword, KEY_PREFIX, newToken, passwordProblem, sameSecret, tokenHash, verifyPassword } from './secrets'

describe('passwords', () => {
  it('checks a password against its hash, and nothing else', async () => {
    const stored = await hashPassword('correct horse battery')
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$/)
    await expect(verifyPassword('correct horse battery', stored)).resolves.toBe(true)
    await expect(verifyPassword('correct horse batterY', stored)).resolves.toBe(false)
  })

  it('salts each hash, so the same password never hashes the same twice', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'))
  })

  it('refuses a stored value it does not recognise', async () => {
    await expect(verifyPassword('anything at all', 'md5$abc')).resolves.toBe(false)
  })

  it('asks for a password long enough to be worth having', () => {
    expect(passwordProblem('short')).toMatch(/at least 10/)
    expect(passwordProblem(undefined)).toMatch(/at least 10/)
    expect(passwordProblem('long enough!')).toBeNull()
  })
})

describe('tokens', () => {
  it('makes keys that say what they are and are never the same', () => {
    const a = newToken(KEY_PREFIX)
    const b = newToken(KEY_PREFIX)
    expect(a).toMatch(/^cp_[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  it('keeps a token only as a hash of it', () => {
    expect(tokenHash('abc')).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenHash('abc')).toBe(tokenHash('abc'))
  })

  it('compares secrets of any length', () => {
    expect(sameSecret('one', 'one')).toBe(true)
    expect(sameSecret('one', 'one-longer')).toBe(false)
  })
})
