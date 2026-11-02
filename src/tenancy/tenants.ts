import type { Db } from '../db/index.js';
import { newId, randomToken, sha256, constantTimeEqual } from '../crypto/vault.js';

export interface Tenant {
  id: string;
  name: string;
  created_at: string;
}

/**
 * API keys look like `chk_<prefix>_<secret>`. Only sha256(secret) is stored; the prefix is a unique lookup handle.
 * MCP tokens use the same construction with `chm_`.
 */
export function mintKey(kind: 'chk' | 'chm') {
  const prefix = randomToken(6).replace(/[-_]/g, 'x');
  const secret = randomToken(24);
  return { prefix, hash: sha256(secret), token: `${kind}_${prefix}_${secret}` };
}

export function parseKey(token: string, kind: 'chk' | 'chm'): { prefix: string; secret: string } | null {
  const m = new RegExp(`^${kind}_([A-Za-z0-9]+)_([A-Za-z0-9_-]+)$`).exec(token);
  return m ? { prefix: m[1], secret: m[2] } : null;
}

export class TenantService {
  constructor(private readonly db: Db) {}

  async create(name: string): Promise<{ tenant: Tenant; apiKey: string }> {
    const id = newId('ten');
    const { rows } = await this.db.query<Tenant>(
      'INSERT INTO tenants (id, name) VALUES ($1, $2) RETURNING *',
      [id, name],
    );
    const apiKey = await this.createApiKey(id, 'default');
    return { tenant: rows[0], apiKey: apiKey.token };
  }

  async list(): Promise<Tenant[]> {
    return (await this.db.query<Tenant>('SELECT * FROM tenants ORDER BY created_at')).rows;
  }

  async get(id: string): Promise<Tenant | undefined> {
    return (await this.db.query<Tenant>('SELECT * FROM tenants WHERE id = $1', [id])).rows[0];
  }

  async createApiKey(tenantId: string, name: string): Promise<{ id: string; token: string }> {
    const k = mintKey('chk');
    const id = newId('ak');
    await this.db.query(
      'INSERT INTO api_keys (id, tenant_id, name, prefix, hash) VALUES ($1, $2, $3, $4, $5)',
      [id, tenantId, name, k.prefix, k.hash],
    );
    return { id, token: k.token };
  }

  async revokeApiKey(tenantId: string, id: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING id',
      [id, tenantId],
    );
    return rows.length > 0;
  }

  /** Resolve an API key to its tenant id, or undefined. */
  async authenticate(token: string): Promise<string | undefined> {
    const parsed = parseKey(token, 'chk');
    if (!parsed) return undefined;
    const { rows } = await this.db.query<{ tenant_id: string; hash: string }>(
      'SELECT tenant_id, hash FROM api_keys WHERE prefix = $1 AND revoked_at IS NULL',
      [parsed.prefix],
    );
    const row = rows[0];
    return row && constantTimeEqual(row.hash, sha256(parsed.secret)) ? row.tenant_id : undefined;
  }
}
