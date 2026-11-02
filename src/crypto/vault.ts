import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Envelope format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts), AES-256-GCM.
 * The key id is bound into the AAD so a ciphertext cannot be replayed under a different key entry.
 * Swap this class for a KMS-backed implementation (AWS KMS / GCP KMS / Vault transit) without touching callers.
 */
export class Vault {
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId: string;
  private readonly hmacKey: Buffer;

  constructor(masterKeys: string) {
    const entries = masterKeys
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!entries.length) throw new Error('MASTER_KEYS is empty');
    for (const entry of entries) {
      const idx = entry.indexOf(':');
      if (idx <= 0) throw new Error('MASTER_KEYS entries must look like <keyId>:<base64 key>');
      const id = entry.slice(0, idx);
      const key = Buffer.from(entry.slice(idx + 1), 'base64');
      if (key.length !== 32)
        throw new Error(`Master key "${id}" must decode to 32 bytes (got ${key.length})`);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Master key id "${id}" must be [A-Za-z0-9_-]`);
      this.keys.set(id, key);
    }
    this.activeKeyId = entries[0].slice(0, entries[0].indexOf(':'));
    this.hmacKey = Buffer.from(
      hkdfSync('sha256', this.keys.get(this.activeKeyId)!, '', 'connect-hub/hmac', 32),
    );
  }

  encrypt(value: unknown): string {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(this.activeKeyId));
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [
      'v1',
      this.activeKeyId,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ct.toString('base64url'),
    ].join('.');
  }

  decrypt<T = unknown>(envelope: string): T {
    const [version, keyId, iv, tag, ct] = envelope.split('.');
    if (version !== 'v1' || !keyId || !iv || !tag || ct === undefined)
      throw new Error('Malformed ciphertext');
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`Unknown encryption key id "${keyId}" — was it removed from MASTER_KEYS?`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(keyId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  }

  /** True when the envelope was written under a key that is no longer the active one (needs re-encryption). */
  isStale(envelope: string): boolean {
    return envelope.split('.')[1] !== this.activeKeyId;
  }

  sign(data: string): string {
    return createHmac('sha256', this.hmacKey).update(data).digest('base64url');
  }

  verify(data: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(data));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url').replace(/[-_]/g, 'x')}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
