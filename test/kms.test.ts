import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { resolveMasterKeys } from '../src/crypto/kms.js';
import { Vault } from '../src/crypto/vault.js';

const plaintextKey = randomBytes(32).toString('base64');
let vault: FastifyInstance;
let addr = '';
const calls: string[] = [];

beforeAll(async () => {
  vault = Fastify();
  vault.post<{ Body: any }>('/v1/auth/kubernetes/login', async (req: any, reply) => {
    calls.push('login');
    if (req.body.role !== 'connect-hub' || req.body.jwt !== 'sa-jwt')
      return reply.status(403).send({ errors: ['permission denied'] });
    return { auth: { client_token: 'vt-from-k8s' } };
  });
  vault.post<{ Body: any }>('/v1/transit/decrypt/connect-hub', async (req: any, reply) => {
    calls.push(`decrypt:${req.headers['x-vault-token']}`);
    if (!['root-token', 'vt-from-k8s'].includes(String(req.headers['x-vault-token'])))
      return reply.status(403).send({ errors: ['permission denied'] });
    if (req.body.ciphertext !== 'vault:v1:wrapped-k1')
      return reply.status(400).send({ errors: ['invalid ciphertext'] });
    return { data: { plaintext: plaintextKey } };
  });
  await vault.listen({ port: 0, host: '127.0.0.1' });
  addr = `http://127.0.0.1:${(vault.server.address() as any).port}`;
});
afterAll(() => vault.close());

const base = { ADMIN_TOKEN: 'x'.repeat(32) };

describe('master keys from Vault Transit', () => {
  it('requires keys or a complete Vault configuration', () => {
    expect(() => loadConfig({ ...base } as any)).toThrow(/MASTER_KEYS/);
    expect(() => loadConfig({ ...base, MASTER_KEYS_WRAPPED: 'k1:vault:v1:x' } as any)).toThrow(/VAULT_ADDR/);
  });

  it('passes plain MASTER_KEYS through untouched', async () => {
    const cfg = loadConfig({ ...base, MASTER_KEYS: `k1:${plaintextKey}` } as any);
    expect(await resolveMasterKeys(cfg)).toBe(`k1:${plaintextKey}`);
  });

  it('unwraps with a Vault token', async () => {
    const cfg = loadConfig({
      ...base,
      MASTER_KEYS_WRAPPED: 'k1:vault:v1:wrapped-k1',
      VAULT_ADDR: addr,
      VAULT_TOKEN: 'root-token',
    } as any);
    const keys = await resolveMasterKeys(cfg);
    expect(keys).toBe(`k1:${plaintextKey}`);
    expect(() => new Vault(keys)).not.toThrow();
  });

  it('unwraps with Kubernetes service-account auth', async () => {
    calls.length = 0;
    const cfg = loadConfig({
      ...base,
      MASTER_KEYS_WRAPPED: 'k1:vault:v1:wrapped-k1',
      VAULT_ADDR: addr,
      VAULT_K8S_ROLE: 'connect-hub',
    } as any);
    expect(await resolveMasterKeys(cfg, async () => 'sa-jwt\n')).toBe(`k1:${plaintextKey}`);
    expect(calls).toEqual(['login', 'decrypt:vt-from-k8s']);
  });

  it('fails loudly when Vault refuses', async () => {
    const cfg = loadConfig({
      ...base,
      MASTER_KEYS_WRAPPED: 'k1:vault:v1:other',
      VAULT_ADDR: addr,
      VAULT_TOKEN: 'root-token',
    } as any);
    await expect(resolveMasterKeys(cfg)).rejects.toThrow(/invalid ciphertext/);
    const bad = loadConfig({
      ...base,
      MASTER_KEYS_WRAPPED: 'k1:plain',
      VAULT_ADDR: addr,
      VAULT_TOKEN: 'root-token',
    } as any);
    await expect(resolveMasterKeys(bad)).rejects.toThrow(/vault:v/);
  });

  it('requires https for the sign-in issuer and Vault, except loopback and in-cluster Vault', () => {
    const cfg = (extra: Record<string, string>) => () =>
      loadConfig({ ...base, MASTER_KEYS: `k1:${plaintextKey}`, ...extra } as any);
    expect(cfg({ OIDC_ISSUER: 'http://keycloak.example.com/realms/x' })).toThrow(/OIDC_ISSUER/);
    expect(cfg({ OIDC_ISSUER: 'https://keycloak.example.com/realms/x' })).not.toThrow();
    expect(cfg({ OIDC_ISSUER: 'http://127.0.0.1:8080/realms/x' })).not.toThrow();
    expect(cfg({ VAULT_ADDR: 'http://vault.example.com:8200' })).toThrow(/VAULT_ADDR/);
    expect(cfg({ VAULT_ADDR: 'http://vault.vault.svc.cluster.local:8200' })).not.toThrow();
    expect(cfg({ OIDC_ISSUER: 'http://keycloak.keycloak.svc/realms/x' })).toThrow(/OIDC_ISSUER/);
  });
});
