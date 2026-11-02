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
 * AES-256-GCM envelopes.
 *
 * - `v2.<keyId>.<iv>.<tag>.<ct>`: tenant-scoped. The data key is derived per tenant with HKDF from the master key,
 *   and "<keyId>|<tenantId>" is the AAD, so a ciphertext copied into another tenant's row does not decrypt and one
 *   tenant's derived key reveals nothing about another's. All tenant data is written this way.
 * - `v1.<keyId>.<iv>.<tag>.<ct>`: master-key envelopes from before v2. Still readable; `isStale` reports them so
 *   callers re-encrypt them as v2 on next use.
 *
 * Master keys come from MASTER_KEYS, or are unwrapped from Vault Transit at startup (see kms.ts), so their plaintext
 * never has to sit in a Kubernetes secret.
 */
export class Vault {
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId: string;
  private readonly hmacKey: Buffer;
  private readonly derived = new Map<string, Buffer>();

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

  private tenantKey(keyId: string, tenantId: string): Buffer {
    const cacheKey = `${keyId}|${tenantId}`;
    let k = this.derived.get(cacheKey);
    if (!k) {
      const master = this.keys.get(keyId);
      if (!master) throw new Error(`Unknown encryption key id "${keyId}" — was it removed from MASTER_KEYS?`);
      k = Buffer.from(hkdfSync('sha256', master, 'connect-hub/tenant-key', `tenant:${tenantId}`, 32));
      this.derived.set(cacheKey, k);
    }
    return k;
  }

  private seal(version: 'v1' | 'v2', key: Buffer, aad: string, value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [
      version,
      this.activeKeyId,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ct.toString('base64url'),
    ].join('.');
  }

  /** Encrypt for a tenant (v2). Without a tenant, a master-key envelope (v1) — only for data no tenant owns. */
  encrypt(value: unknown, tenantId?: string): string {
    if (tenantId)
      return this.seal(
        'v2',
        this.tenantKey(this.activeKeyId, tenantId),
        `${this.activeKeyId}|${tenantId}`,
        value,
      );
    return this.seal('v1', this.keys.get(this.activeKeyId)!, this.activeKeyId, value);
  }

  decrypt<T = unknown>(envelope: string, tenantId?: string): T {
    const [version, keyId, iv, tag, ct] = envelope.split('.');
    if (!['v1', 'v2'].includes(version) || !keyId || !iv || !tag || ct === undefined)
      throw new Error('Malformed ciphertext');
    let key: Buffer;
    let aad: string;
    if (version === 'v2') {
      if (!tenantId) throw new Error('This ciphertext belongs to a tenant; pass the tenant id');
      key = this.tenantKey(keyId, tenantId);
      aad = `${keyId}|${tenantId}`;
    } else {
      const k = this.keys.get(keyId);
      if (!k) throw new Error(`Unknown encryption key id "${keyId}" — was it removed from MASTER_KEYS?`);
      key = k;
      aad = keyId;
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  }

  /** True when the envelope should be re-encrypted: written under a retired key, or a pre-tenant (v1) envelope. */
  isStale(envelope: string): boolean {
    const [version, keyId] = envelope.split('.');
    return keyId !== this.activeKeyId || version !== 'v2';
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
