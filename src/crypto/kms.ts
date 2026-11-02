/**
 * Master-key custody through HashiCorp Vault Transit. The operator stores only Transit ciphertexts
 * (MASTER_KEYS_WRAPPED="k1:vault:v1:…"); at startup the hub authenticates to Vault (token, or Kubernetes service
 * account) and asks Transit to decrypt them. The plaintext keys live only in process memory.
 *
 * Wrap a new key:
 *   vault write -field=ciphertext transit/encrypt/connect-hub plaintext=$(openssl rand -base64 32)
 */
import { readFile } from 'node:fs/promises';
import type { Config } from '../config.js';

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

async function vaultFetch(config: Config, path: string, body: unknown, token?: string) {
  const res = await fetch(`${config.VAULT_ADDR!.replace(/\/+$/, '')}/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-vault-token': token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`Vault ${path} failed: HTTP ${res.status} ${(data.errors ?? []).join('; ')}`);
  return data;
}

async function vaultToken(config: Config, readToken: () => Promise<string>): Promise<string> {
  if (config.VAULT_TOKEN) return config.VAULT_TOKEN;
  const jwt = (await readToken()).trim();
  const data = await vaultFetch(config, `auth/${config.VAULT_K8S_MOUNT}/login`, {
    role: config.VAULT_K8S_ROLE,
    jwt,
  });
  return data.auth.client_token;
}

/** Return MASTER_KEYS in plaintext form, unwrapping MASTER_KEYS_WRAPPED through Vault when configured. */
export async function resolveMasterKeys(
  config: Config,
  readServiceAccountToken: () => Promise<string> = () => readFile(SA_TOKEN_PATH, 'utf8'),
): Promise<string> {
  if (!config.MASTER_KEYS_WRAPPED) return config.MASTER_KEYS!;
  const token = await vaultToken(config, readServiceAccountToken);
  const entries = config.MASTER_KEYS_WRAPPED.split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const entry of entries) {
    const i = entry.indexOf(':');
    if (i <= 0 || !entry.slice(i + 1).startsWith('vault:')) {
      throw new Error('MASTER_KEYS_WRAPPED entries must look like <keyId>:vault:v<n>:<ciphertext>');
    }
    const data = await vaultFetch(
      config,
      `${config.VAULT_TRANSIT_MOUNT}/decrypt/${config.VAULT_TRANSIT_KEY}`,
      { ciphertext: entry.slice(i + 1) },
      token,
    );
    out.push(`${entry.slice(0, i)}:${data.data.plaintext}`);
  }
  return out.join(',');
}
