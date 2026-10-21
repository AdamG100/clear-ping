import type { DnsRecordType } from '@/types/probe'

/**
 * DNS messages as they travel: writing a question and reading the answer.
 *
 * Node's own resolver speaks plain DNS to an address and nothing else. DNS
 * over TLS and DNS over HTTPS carry the very same message inside a different
 * envelope, so asking over either means building that message by hand and
 * taking the reply apart again. Only the record types a target can ask for
 * are read; anything else in a reply is stepped over.
 */

const TYPE_CODE: Record<DnsRecordType, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 }

const CLASS_INTERNET = 1
const HEADER_BYTES = 12
/** "Recursion desired": ask the resolver to go and find out, which is what it is for. */
const FLAG_RECURSION_DESIRED = 0x0100
const FLAG_TRUNCATED = 0x0200

/** The reply codes that come up, by the names they are known by. */
const RCODE_NAME: Record<number, string> = {
  0: 'NOERROR',
  1: 'FORMERR',
  2: 'SERVFAIL',
  3: 'NXDOMAIN',
  4: 'NOTIMP',
  5: 'REFUSED',
}

export const RCODE_NXDOMAIN = 3

export function rcodeName(rcode: number): string {
  return RCODE_NAME[rcode] ?? `RCODE ${rcode}`
}

/** The question "what is the `type` record of `name`", as a DNS message. */
export function encodeQuery(name: string, type: DnsRecordType, id = 0): Buffer {
  const labels = name.replace(/\.$/, '').split('.')
  if (labels.some(label => label.length === 0 || label.length > 63)) {
    throw new Error(`${name} is not a name that can be asked for`)
  }

  const question = Buffer.concat([
    ...labels.map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')])),
    Buffer.from([0]),
  ])

  const message = Buffer.alloc(HEADER_BYTES + question.length + 4)
  message.writeUInt16BE(id & 0xffff, 0)
  message.writeUInt16BE(FLAG_RECURSION_DESIRED, 2)
  message.writeUInt16BE(1, 4) // one question
  question.copy(message, HEADER_BYTES)
  message.writeUInt16BE(TYPE_CODE[type], HEADER_BYTES + question.length)
  message.writeUInt16BE(CLASS_INTERNET, HEADER_BYTES + question.length + 2)
  return message
}

/**
 * Read a name starting at `offset`. Names are compressed: any part of one may
 * be a pointer back to where the same letters already appear in the message.
 * Returns the name and the offset of whatever follows it.
 */
function readName(message: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = []
  let position = offset
  let next = -1

  // A message cannot hold more labels than it has bytes; more jumps than that
  // is a pointer leading back to itself.
  for (let steps = 0; steps <= message.length; steps++) {
    const length = message[position]
    if (length === undefined) throw new Error('DNS reply ends in the middle of a name')

    if (length === 0) {
      return { name: labels.join('.'), next: next === -1 ? position + 1 : next }
    }

    if ((length & 0xc0) === 0xc0) {
      if (position + 1 >= message.length) throw new Error('DNS reply ends in the middle of a name')
      if (next === -1) next = position + 2
      position = ((length & 0x3f) << 8) | message[position + 1]
      continue
    }

    const end = position + 1 + length
    if (end > message.length) throw new Error('DNS reply ends in the middle of a name')
    labels.push(message.toString('ascii', position + 1, end))
    position = end
  }
  throw new Error('DNS reply has a name that never ends')
}

/** An IPv6 address the way it is usually written: no leading zeros, the longest run of them folded. */
function formatIpv6(bytes: Buffer): string {
  const groups: number[] = []
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index))

  let bestStart = -1
  let bestLength = 0
  for (let start = 0; start < 8; start++) {
    let length = 0
    while (start + length < 8 && groups[start + length] === 0) length++
    if (length > bestLength) {
      bestStart = start
      bestLength = length
    }
  }

  const hex = (from: number, to: number) => groups.slice(from, to).map(group => group.toString(16)).join(':')
  // A single zero group is written out; folding is for runs.
  if (bestLength < 2) return hex(0, 8)
  return `${hex(0, bestStart)}::${hex(bestStart + bestLength, 8)}`
}

function readRecord(message: Buffer, type: DnsRecordType, start: number, length: number): string {
  const data = message.subarray(start, start + length)

  switch (type) {
    case 'A':
      if (length !== 4) throw new Error('DNS reply has an A record of the wrong size')
      return [...data].join('.')
    case 'AAAA':
      if (length !== 16) throw new Error('DNS reply has an AAAA record of the wrong size')
      return formatIpv6(data)
    case 'CNAME':
    case 'NS':
      // Read from the whole message: the name may point back into it.
      return readName(message, start).name
    case 'MX':
      // Two bytes of preference, then the name that matters.
      return readName(message, start + 2).name
    case 'TXT': {
      // A run of strings, each with its length in front, that belong together.
      const parts: string[] = []
      for (let offset = 0; offset < data.length; ) {
        const size = data[offset]
        parts.push(data.toString('utf8', offset + 1, offset + 1 + size))
        offset += 1 + size
      }
      return parts.join('')
    }
  }
}

export interface DnsReply {
  id: number
  /** 0 for an answer, 3 for "no such name", and so on. */
  rcode: number
  /** Cut short to fit: only ever seen over plain UDP. */
  truncated: boolean
  /** The records of the type that was asked for, in the order they came. */
  answers: string[]
}

/** Take a reply apart, keeping the records of the type that was asked for. */
export function decodeReply(message: Buffer, type: DnsRecordType): DnsReply {
  if (message.length < HEADER_BYTES) throw new Error('DNS reply is too short to be one')

  const flags = message.readUInt16BE(2)
  const questions = message.readUInt16BE(4)
  const answerCount = message.readUInt16BE(6)

  let offset = HEADER_BYTES
  for (let index = 0; index < questions; index++) {
    offset = readName(message, offset).next + 4
  }

  const answers: string[] = []
  for (let index = 0; index < answerCount; index++) {
    offset = readName(message, offset).next
    if (offset + 10 > message.length) throw new Error('DNS reply ends in the middle of a record')

    const recordType = message.readUInt16BE(offset)
    const length = message.readUInt16BE(offset + 8)
    const start = offset + 10
    if (start + length > message.length) throw new Error('DNS reply ends in the middle of a record')

    // A reply to "what is its address" usually leads with the aliases that
    // were followed to get there. Those are not what was asked for.
    if (recordType === TYPE_CODE[type]) answers.push(readRecord(message, type, start, length))
    offset = start + length
  }

  return {
    id: message.readUInt16BE(0),
    rcode: flags & 0x000f,
    truncated: (flags & FLAG_TRUNCATED) !== 0,
    answers,
  }
}

/** A message as DNS over TLS (and over TCP) sends it: its length in two bytes, then the message. */
export function frameMessage(message: Buffer): Buffer {
  const framed = Buffer.alloc(message.length + 2)
  framed.writeUInt16BE(message.length, 0)
  message.copy(framed, 2)
  return framed
}

/**
 * The first whole message in what has arrived so far, and what is left over.
 * Null while the message is still arriving: a reply can come in pieces.
 */
export function unframeMessage(received: Buffer): { message: Buffer; rest: Buffer } | null {
  if (received.length < 2) return null
  const length = received.readUInt16BE(0)
  if (received.length < 2 + length) return null
  return { message: received.subarray(2, 2 + length), rest: received.subarray(2 + length) }
}
