import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Vault } from '../src/crypto/vault.js';

const key = () => randomBytes(32).toString('base64');

describe('Vault', () => {
  it('round-trips values', () => {
    const v = new Vault(`a:${key()}`);
    const env = v.encrypt({ token: 'secret', n: 1 });
    expect(env.startsWith('v1.a.')).toBe(true);
    expect(env).not.toContain('secret');
    expect(v.decrypt(env)).toEqual({ token: 'secret', n: 1 });
  });

  it('decrypts with retired keys after rotation and flags stale envelopes', () => {
    const oldKey = key();
    const before = new Vault(`old:${oldKey}`);
    const env = before.encrypt('x');
    const after = new Vault(`new:${key()},old:${oldKey}`);
    expect(after.decrypt(env)).toBe('x');
    expect(after.isStale(env)).toBe(true);
    expect(after.isStale(after.encrypt('y', 'ten_A'))).toBe(false);
  });

  it('rejects tampered ciphertext and unknown keys', () => {
    const v = new Vault(`a:${key()}`);
    const parts = v.encrypt('hello').split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => v.decrypt(parts.join('.'))).toThrow();
    expect(() => new Vault(`b:${key()}`).decrypt(v.encrypt('z'))).toThrow(/Unknown encryption key/);
  });

  it('validates key material', () => {
    expect(() => new Vault('a:c2hvcnQ=')).toThrow(/32 bytes/);
    expect(() => new Vault('nokeyid')).toThrow();
  });

  it('signs and verifies', () => {
    const v = new Vault(`a:${key()}`);
    const s = v.sign('state:1');
    expect(v.verify('state:1', s)).toBe(true);
    expect(v.verify('state:2', s)).toBe(false);
  });
});

describe('tenant-scoped envelopes (v2)', () => {
  it('only decrypts for the tenant it was written for', () => {
    const v = new Vault(`a:${key()}`);
    const env = v.encrypt({ token: 't' }, 'ten_A');
    expect(env.startsWith('v2.a.')).toBe(true);
    expect(v.decrypt(env, 'ten_A')).toEqual({ token: 't' });
    expect(() => v.decrypt(env, 'ten_B')).toThrow();
    expect(() => v.decrypt(env)).toThrow(/tenant/);
  });

  it('still reads v1 envelopes and marks them for re-encryption', () => {
    const v = new Vault(`a:${key()}`);
    const legacy = v.encrypt('old');
    expect(v.decrypt(legacy, 'ten_A')).toBe('old');
    expect(v.isStale(legacy)).toBe(true);
    expect(v.isStale(v.encrypt('new', 'ten_A'))).toBe(false);
  });

  it('derives different keys per tenant and survives key rotation', () => {
    const oldKey = key();
    const before = new Vault(`old:${oldKey}`);
    const env = before.encrypt('x', 'ten_A');
    const after = new Vault(`new:${key()},old:${oldKey}`);
    expect(after.decrypt(env, 'ten_A')).toBe('x');
    expect(after.isStale(env)).toBe(true);
  });
});
