import { describe, expect, it } from 'vitest'
import { reachesMachineOnly } from './delivery'

describe('a notification URL', () => {
  it('is refused when it calls a link-local or metadata address, however that is written', () => {
    for (const url of [
      'json://169.254.169.254/latest/meta-data',
      'jsons://169.254.169.254',
      'xml://169.254.1.1/x',
      'form://user:secret@169.254.169.254/x',
      'http://169.254.169.254/',
      'HTTPS://169.254.169.254/',
      'json://2852039166/',
      'json://0xa9fea9fe/',
      'json://[fe80::1]/',
      'json://[::ffff:169.254.169.254]/',
      'json://[fd00:ec2::254]/',
      'json://metadata.google.internal/computeMetadata/v1/',
      'json://METADATA.GOOGLE.INTERNAL./',
    ]) {
      expect(reachesMachineOnly(url), url).toBe(true)
    }
  })

  it('is left alone for anything else', () => {
    for (const url of [
      'discord://123/token',
      'mailto://user:pass@mail.example',
      'json://192.0.2.10/hook',
      'https://hooks.example/abc',
      'json://hooks.example:8080/abc',
      'tgram://169.254.169.254/1',
      'not a url',
    ]) {
      expect(reachesMachineOnly(url), url).toBe(false)
    }
  })
})
