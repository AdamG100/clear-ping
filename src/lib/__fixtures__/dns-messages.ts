import type { DnsRecordType } from '@/types/probe'

/**
 * DNS replies built by hand, for reading back: what a resolver would send,
 * without there being one.
 */

export const TYPE_CODE: Record<DnsRecordType, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 }

/** A name written out label by label, the long way. */
export function wireName(text: string): Buffer {
  return Buffer.concat([
    ...text.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')])),
    Buffer.from([0]),
  ])
}

/** A pointer back to `offset`: how a reply avoids writing a name twice. */
export const wirePointer = (offset: number) => Buffer.from([0xc0 | (offset >> 8), offset & 0xff])

/** One record of an answer, owned by the name the question asked about. */
export function wireRecord(type: DnsRecordType, data: Buffer): Buffer {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(TYPE_CODE[type], 0)
  head.writeUInt16BE(1, 2)
  head.writeUInt32BE(300, 4)
  head.writeUInt16BE(data.length, 8)
  // The question's name starts right after the twelve-byte header.
  return Buffer.concat([wirePointer(12), head, data])
}

/** An address record, from the address as it is written. */
export function addressRecord(address: string): Buffer {
  return wireRecord('A', Buffer.from(address.split('.').map(Number)))
}

/** A reply to "what is the `type` of `asked`", carrying `records`. */
export function wireReply(
  asked: string,
  type: DnsRecordType,
  records: Buffer[],
  { rcode = 0, truncated = false }: { rcode?: number; truncated?: boolean } = {}
): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x1234, 0)
  header.writeUInt16BE(0x8180 | (truncated ? 0x0200 : 0) | rcode, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(records.length, 6)

  const question = Buffer.alloc(4)
  question.writeUInt16BE(TYPE_CODE[type], 0)
  question.writeUInt16BE(1, 2)

  return Buffer.concat([header, wireName(asked), question, ...records])
}

/** The name a query asks about, read back out of it. */
export function askedName(query: Buffer): string {
  const labels: string[] = []
  for (let offset = 12; query[offset] !== 0; offset += query[offset] + 1) {
    labels.push(query.toString('ascii', offset + 1, offset + 1 + query[offset]))
  }
  return labels.join('.')
}

/** The record type a query asks for, read back out of it. */
export function askedType(query: Buffer): DnsRecordType {
  let offset = 12
  while (query[offset] !== 0) offset += query[offset] + 1
  const code = query.readUInt16BE(offset + 1)
  return (Object.keys(TYPE_CODE) as DnsRecordType[]).find(type => TYPE_CODE[type] === code) ?? 'A'
}
