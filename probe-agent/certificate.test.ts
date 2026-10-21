import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCertificate, loadOrCreateCertificate } from './certificate'

describe('the probe agent’s certificate', () => {
  it('is a well-formed certificate signed by its own key', () => {
    const { cert, key } = createCertificate('clearping-probe-agent test', new Date('2026-10-20T12:00:00Z'))
    const parsed = new X509Certificate(cert)

    expect(parsed.subject).toBe('CN=clearping-probe-agent test')
    expect(parsed.issuer).toBe(parsed.subject)
    expect(parsed.ca).toBe(true)
    expect(parsed.verify(createPublicKey(key))).toBe(true)
    expect(parsed.checkPrivateKey(createPrivateKey(key))).toBe(true)
    expect(new Date(parsed.validFrom).getTime()).toBeLessThan(new Date('2026-10-20T12:00:00Z').getTime())
    expect(new Date(parsed.validTo).getUTCFullYear()).toBe(2046)
  })

  it('writes dates past 2049 in the long form', () => {
    const { cert } = createCertificate('later', new Date('2040-01-01T00:00:00Z'))
    expect(new Date(new X509Certificate(cert).validTo).getUTCFullYear()).toBe(2060)
  })

  it('is made once and then kept', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clearping-agent-cert-'))
    try {
      const first = loadOrCreateCertificate(directory, 'kept')
      const second = loadOrCreateCertificate(directory, 'kept')

      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.fingerprint).toBe(first.fingerprint)
      expect(first.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(directory, 'probe-agent-key.pem')).mode & 0o777).toBe(0o600)
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
