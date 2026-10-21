import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The probe agent's own certificate, made the first time it starts and kept.
 *
 * Self-signed on purpose: no certificate authority could vouch for a box on a
 * tailnet or a bare VPS address, and none is needed. The dashboard pins this
 * exact certificate the first time it connects and from then on talks to
 * nothing else, so the link is encrypted and the agent is known on any
 * network, with nothing for whoever runs it to set up.
 *
 * Built here with Node's own crypto rather than a library: an X.509
 * certificate is a few nested DER sequences, and signing it is one call.
 */

export interface AgentCertificate {
  key: string;
  cert: string;
  /** SHA-256 of the certificate, as `AB:CD:…`: what the dashboard shows to compare against. */
  fingerprint: string;
}

// ─── DER ─────────────────────────────────────────────────────────────────────

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const explicit = (n: number, inner: Buffer) => tlv(0xa0 + n, inner);

function integer(bytes: Buffer): Buffer {
  // Positive, so a leading byte with its top bit set needs a zero in front.
  return tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const chunk = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime up to 2049, GeneralizedTime from 2050, as X.509 requires. */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const ECDSA_WITH_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));
const COMMON_NAME = '2.5.4.3';
const BASIC_CONSTRAINTS = '2.5.29.19';

// ─── Certificate ─────────────────────────────────────────────────────────────

export function createCertificate(commonName: string, now = new Date()): Omit<AgentCertificate, 'fingerprint'> {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const name = sequence(set(sequence(oid(COMMON_NAME), utf8(commonName))));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x01;

  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 20);

  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ECDSA_WITH_SHA256,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    // Marked as its own authority, which is what it is: the one certificate
    // the dashboard trusts for this agent.
    explicit(3, sequence(sequence(oid(BASIC_CONSTRAINTS), tlv(0x01, Buffer.from([0xff])), tlv(0x04, sequence(tlv(0x01, Buffer.from([0xff]))))))),
  );

  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.from([0]), signature));
  const base64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
  };
}

export function fingerprintOf(cert: string): string {
  return new X509Certificate(cert).fingerprint256;
}

/** The certificate kept in `directory`, made and saved there first if there is none. */
export function loadOrCreateCertificate(directory: string, commonName: string): AgentCertificate & { created: boolean } {
  const keyPath = join(directory, 'probe-agent-key.pem');
  const certPath = join(directory, 'probe-agent-cert.pem');

  if (existsSync(keyPath) && existsSync(certPath)) {
    const cert = readFileSync(certPath, 'utf8');
    return { key: readFileSync(keyPath, 'utf8'), cert, fingerprint: fingerprintOf(cert), created: false };
  }

  mkdirSync(directory, { recursive: true });
  const made = createCertificate(commonName);
  writeFileSync(keyPath, made.key, { mode: 0o600 });
  // writeFileSync only applies the mode to a file it creates.
  chmodSync(keyPath, 0o600);
  writeFileSync(certPath, made.cert);
  return { ...made, fingerprint: fingerprintOf(made.cert), created: true };
}
