/**
 * OAuth 2.1 authorization server for the hub's MCP endpoints (MCP authorization spec):
 * protected-resource metadata (RFC 9728), AS metadata (RFC 8414), dynamic client registration (RFC 7591),
 * authorization code + PKCE S256, resource indicators (RFC 8707), rotating refresh tokens, revocation (RFC 7009).
 *
 * Each MCP server config is its own resource: `<PUBLIC_URL>/mcp/s/<serverId>`. Signing in goes through the configured
 * OIDC provider; the server's tenant decides which email domains or addresses may authorize. The resulting access
 * token is bound to (tenant, user = email, server), exactly like a per-user MCP token.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { newId, randomToken, sha256, type Vault } from '../crypto/vault.js';
import { AppError } from '../errors.js';
import type { OidcClient, OidcIdentity } from './oidc.js';

export class OAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: string,
    public readonly description: string,
  ) {
    super(description);
  }
}

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
}

interface RequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scope: string | null;
  resource: string;
  tenant_id: string;
  server_id: string;
  oidc_secret_enc: string;
  user_id: string | null;
  user_name: string | null;
  expires_at: Date | string;
  completed_at: Date | string | null;
}

export interface OAuthBinding {
  tenantId: string;
  userId: string;
  serverId: string;
}

const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];

function safeEq(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string') return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    // Native/CLI clients use loopback redirects (RFC 8252).
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export class McpOAuthServer {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly config: Config,
    private readonly oidc: OidcClient,
  ) {}

  get issuer() {
    return this.config.PUBLIC_URL;
  }

  resourceFor(serverId: string) {
    return `${this.config.PUBLIC_URL}/mcp/s/${serverId}`;
  }

  resourceMetadataUrl(serverId: string) {
    return `${this.config.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp/s/${serverId}`;
  }

  protectedResourceMetadata(serverId: string, serverName?: string) {
    return {
      resource: this.resourceFor(serverId),
      authorization_servers: [this.issuer],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
      ...(serverName ? { resource_name: serverName } : {}),
    };
  }

  authorizationServerMetadata() {
    const b = this.issuer;
    return {
      issuer: b,
      authorization_endpoint: `${b}/oauth2/authorize`,
      token_endpoint: `${b}/oauth2/token`,
      registration_endpoint: `${b}/oauth2/register`,
      revocation_endpoint: `${b}/oauth2/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: AUTH_METHODS,
      scopes_supported: ['mcp'],
      authorization_response_iss_parameter_supported: true,
    };
  }

  // ───────────────────────────── registration ─────────────────────────────

  async register(body: Record<string, any>) {
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || !redirectUris.length || !redirectUris.every(validRedirect)) {
      throw new OAuthError(
        400,
        'invalid_redirect_uri',
        'redirect_uris must be https (or http loopback) URLs without fragments',
      );
    }
    const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!AUTH_METHODS.includes(method)) {
      throw new OAuthError(
        400,
        'invalid_client_metadata',
        `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`,
      );
    }
    const grantTypes: string[] = body.grant_types ?? ['authorization_code', 'refresh_token'];
    const responseTypes: string[] = body.response_types ?? ['code'];
    if (
      !grantTypes.every((g) => ['authorization_code', 'refresh_token'].includes(g)) ||
      !grantTypes.includes('authorization_code')
    ) {
      throw new OAuthError(
        400,
        'invalid_client_metadata',
        'grant_types must include authorization_code (and optionally refresh_token)',
      );
    }
    if (responseTypes.length !== 1 || responseTypes[0] !== 'code') {
      throw new OAuthError(400, 'invalid_client_metadata', 'response_types must be ["code"]');
    }
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : null;
    const clientId = `mcpc_${randomToken(16)}`;
    const secret = method === 'none' ? undefined : `mcps_${randomToken(32)}`;
    await this.db.query(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, response_types,
         token_endpoint_auth_method) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        clientId,
        secret ? sha256(secret) : null,
        name,
        JSON.stringify(redirectUris),
        JSON.stringify(grantTypes),
        JSON.stringify(responseTypes),
        method,
      ],
    );
    return {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name ?? undefined,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: method,
    };
  }

  private async client(clientId: unknown): Promise<ClientRow | undefined> {
    if (typeof clientId !== 'string') return undefined;
    return (await this.db.query<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]))
      .rows[0];
  }

  /** Authenticate a client at the token/revocation endpoints. */
  private async authenticateClient(body: Record<string, any>, authorization?: string): Promise<ClientRow> {
    let clientId = body.client_id as string | undefined;
    let secret = body.client_secret as string | undefined;
    if (authorization?.startsWith('Basic ')) {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      clientId = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    }
    const c = await this.client(clientId);
    if (!c) throw new OAuthError(401, 'invalid_client', 'Unknown client');
    if (c.token_endpoint_auth_method !== 'none') {
      if (!secret || !c.client_secret_hash || !safeEq(sha256(secret), c.client_secret_hash)) {
        throw new OAuthError(401, 'invalid_client', 'Client authentication failed');
      }
    }
    return c;
  }

  // ───────────────────────────── authorization ─────────────────────────────

  /**
   * Validate an authorization request and start sign-in. Returns where to send the browser. Errors that make the
   * redirect URI untrustworthy throw AppError (shown as a page); the rest go back to the client as `error=`.
   */
  async authorize(
    q: Record<string, string | undefined>,
    resolveServer: (serverId: string) => Promise<{ tenantId: string } | undefined>,
  ): Promise<string> {
    const c = await this.client(q.client_id);
    if (!c) throw new AppError(400, 'invalid_client', 'Unknown OAuth client. Register the client first.');
    if (!q.redirect_uri || !c.redirect_uris.includes(q.redirect_uri)) {
      throw new AppError(400, 'invalid_redirect_uri', 'redirect_uri is not registered for this client');
    }
    const back = (error: string, description: string) => {
      const u = new URL(q.redirect_uri!);
      u.searchParams.set('error', error);
      u.searchParams.set('error_description', description);
      if (q.state) u.searchParams.set('state', q.state);
      u.searchParams.set('iss', this.issuer);
      return u.toString();
    };
    if (q.response_type !== 'code')
      return back('unsupported_response_type', 'Only response_type=code is supported');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    const prefix = `${this.config.PUBLIC_URL}/mcp/s/`;
    const resource = (q.resource ?? '').replace(/\/+$/, '');
    if (!resource.startsWith(prefix))
      return back('invalid_target', `resource must be an MCP endpoint of this hub (${prefix}<id>)`);
    const serverId = resource.slice(prefix.length);
    const server = /^[A-Za-z0-9_-]+$/.test(serverId) ? await resolveServer(serverId) : undefined;
    if (!server) return back('invalid_target', 'Unknown MCP server');
    if (!this.oidc.enabled)
      return back('temporarily_unavailable', 'Single sign-on is not configured on this hub');

    const id = newId('oar');
    const oidcSecret = { verifier: randomToken(48), nonce: randomToken(24) };
    await this.db.query(
      `INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, scope, resource, tenant_id, server_id,
         oidc_secret_enc, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        c.client_id,
        q.redirect_uri,
        q.state ?? null,
        q.code_challenge,
        q.scope ?? 'mcp',
        resource,
        server.tenantId,
        serverId,
        this.vault.encrypt(oidcSecret, server.tenantId),
        new Date(Date.now() + REQUEST_TTL_MS),
      ],
    );
    return this.oidc.authorizeUrl(
      `${id}.${this.vault.sign(`oidc:${id}`)}`,
      oidcSecret.nonce,
      oidcSecret.verifier,
    );
  }

  private async openRequest(id: string): Promise<RequestRow> {
    const r = (await this.db.query<RequestRow>('SELECT * FROM oauth_requests WHERE id = $1', [id])).rows[0];
    if (!r) throw new AppError(400, 'invalid_request', 'This sign-in request does not exist');
    if (r.completed_at) throw new AppError(410, 'request_used', 'This sign-in request was already completed');
    if (new Date(r.expires_at).getTime() < Date.now())
      throw new AppError(410, 'request_expired', 'This sign-in request expired. Start again from your app.');
    return r;
  }

  private async policyAllows(tenantId: string, email: string): Promise<boolean> {
    const t = (
      await this.db.query<{ sso_allowed_domains: string[]; sso_allowed_emails: string[] }>(
        'SELECT sso_allowed_domains, sso_allowed_emails FROM tenants WHERE id = $1',
        [tenantId],
      )
    ).rows[0];
    if (!t) return false;
    const domain = email.split('@')[1] ?? '';
    return (
      t.sso_allowed_emails.map((e) => e.toLowerCase()).includes(email) ||
      t.sso_allowed_domains.map((d) => d.toLowerCase().replace(/^@/, '')).includes(domain)
    );
  }

  /** OIDC callback: verify the sign-in and the tenant policy, then return what the consent page shows. */
  async completeSignIn(state: string, code: string) {
    const [id, sig] = String(state ?? '').split('.');
    if (!id || !sig || !this.vault.verify(`oidc:${id}`, sig))
      throw new AppError(403, 'invalid_state', 'Invalid sign-in state');
    const r = await this.openRequest(id);
    const secret = this.vault.decrypt<{ verifier: string; nonce: string }>(r.oidc_secret_enc, r.tenant_id);
    const who: OidcIdentity = await this.oidc.exchange(code, secret.verifier, secret.nonce);
    if (!(await this.policyAllows(r.tenant_id, who.email))) {
      throw new AppError(
        403,
        'not_allowed',
        `${who.email} is not allowed to use this organization's tools. Ask its administrator for access.`,
      );
    }
    await this.db.query('UPDATE oauth_requests SET user_id = $1, user_name = $2 WHERE id = $3', [
      who.email,
      who.name ?? null,
      id,
    ]);
    const c = (await this.client(r.client_id))!;
    return {
      requestId: id,
      consentToken: this.vault.sign(`consent:${id}:${who.email}`),
      email: who.email,
      clientName: c.client_name ?? 'An application',
      redirectHost: new URL(r.redirect_uri).host,
      serverId: r.server_id,
      tenantId: r.tenant_id,
    };
  }

  /** Consent decision → redirect back to the client with a code (or access_denied). */
  async decide(requestId: string, consentToken: string, allow: boolean): Promise<string> {
    const r = await this.openRequest(requestId);
    if (!r.user_id || !this.vault.verify(`consent:${requestId}:${r.user_id}`, consentToken ?? '')) {
      throw new AppError(403, 'invalid_consent', 'Invalid consent form');
    }
    await this.db.query(
      'UPDATE oauth_requests SET completed_at = now(), oidc_secret_enc = $2 WHERE id = $1',
      [requestId, ''],
    );
    const u = new URL(r.redirect_uri);
    if (r.state) u.searchParams.set('state', r.state);
    u.searchParams.set('iss', this.issuer);
    if (!allow) {
      u.searchParams.set('error', 'access_denied');
      u.searchParams.set('error_description', 'The user declined');
      return u.toString();
    }
    const code = `mcpa_${randomToken(32)}`;
    await this.db.query(
      `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, tenant_id, server_id, user_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        sha256(code),
        r.client_id,
        r.redirect_uri,
        r.code_challenge,
        r.resource,
        r.tenant_id,
        r.server_id,
        r.user_id,
        new Date(Date.now() + CODE_TTL_MS),
      ],
    );
    u.searchParams.set('code', code);
    return u.toString();
  }

  // ───────────────────────────── tokens ─────────────────────────────

  private async issue(b: {
    clientId: string;
    tenantId: string;
    serverId: string;
    userId: string;
    resource: string;
    familyId?: string;
  }) {
    const familyId = b.familyId ?? newId('fam');
    const access = `cha_${randomToken(32)}`;
    const refresh = `chr_${randomToken(32)}`;
    const accessTtl = this.config.MCP_OAUTH_ACCESS_TTL_SECONDS;
    for (const [kind, token, ttlMs] of [
      ['access', access, accessTtl * 1000],
      ['refresh', refresh, this.config.MCP_OAUTH_REFRESH_TTL_DAYS * 86_400_000],
    ] as const) {
      await this.db.query(
        `INSERT INTO oauth_tokens (id, kind, token_hash, family_id, client_id, tenant_id, server_id, user_id, resource, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          newId('tok'),
          kind,
          sha256(token),
          familyId,
          b.clientId,
          b.tenantId,
          b.serverId,
          b.userId,
          b.resource,
          new Date(Date.now() + ttlMs),
        ],
      );
    }
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: accessTtl,
      refresh_token: refresh,
      scope: 'mcp',
    };
  }

  async token(body: Record<string, any>, authorization?: string) {
    const c = await this.authenticateClient(body, authorization);
    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.code_verifier || !body.redirect_uri) {
        throw new OAuthError(400, 'invalid_request', 'code, code_verifier and redirect_uri are required');
      }
      // Single use: mark used atomically and act only if this request was the one that did it.
      const row = (
        await this.db.query(
          `UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL RETURNING *`,
          [sha256(String(body.code))],
        )
      ).rows[0];
      if (!row) throw new OAuthError(400, 'invalid_grant', 'Authorization code is invalid or already used');
      if (row.client_id !== c.client_id || row.redirect_uri !== body.redirect_uri) {
        throw new OAuthError(
          400,
          'invalid_grant',
          'Authorization code was issued to another client or redirect_uri',
        );
      }
      if (new Date(row.expires_at).getTime() < Date.now())
        throw new OAuthError(400, 'invalid_grant', 'Authorization code expired');
      const challenge = createHash('sha256').update(String(body.code_verifier)).digest('base64url');
      if (!safeEq(challenge, row.code_challenge))
        throw new OAuthError(400, 'invalid_grant', 'PKCE verification failed');
      if (body.resource && String(body.resource).replace(/\/+$/, '') !== row.resource) {
        throw new OAuthError(400, 'invalid_target', 'resource does not match the authorization');
      }
      return this.issue({
        clientId: c.client_id,
        tenantId: row.tenant_id,
        serverId: row.server_id,
        userId: row.user_id,
        resource: row.resource,
      });
    }
    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) throw new OAuthError(400, 'invalid_request', 'refresh_token is required');
      const hash = sha256(String(body.refresh_token));
      const row = (
        await this.db.query(`SELECT * FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh'`, [hash])
      ).rows[0];
      if (!row || row.client_id !== c.client_id)
        throw new OAuthError(400, 'invalid_grant', 'Refresh token is invalid');
      if (row.revoked_at || row.used_at) {
        // Replay of a rotated token: assume theft and revoke the whole family.
        await this.db.query(
          'UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
          [row.family_id],
        );
        throw new OAuthError(
          400,
          'invalid_grant',
          'Refresh token was already used; all tokens of this grant are revoked',
        );
      }
      if (new Date(row.expires_at).getTime() < Date.now())
        throw new OAuthError(400, 'invalid_grant', 'Refresh token expired');
      const claimed = (
        await this.db.query(
          `UPDATE oauth_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
          [row.id],
        )
      ).rows[0];
      if (!claimed) throw new OAuthError(400, 'invalid_grant', 'Refresh token was already used');
      // The previous access token of this family stops working once a new pair is issued.
      await this.db.query(
        `UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND kind = 'access' AND revoked_at IS NULL`,
        [row.family_id],
      );
      return this.issue({
        clientId: c.client_id,
        tenantId: row.tenant_id,
        serverId: row.server_id,
        userId: row.user_id,
        resource: row.resource,
        familyId: row.family_id,
      });
    }
    throw new OAuthError(
      400,
      'unsupported_grant_type',
      'grant_type must be authorization_code or refresh_token',
    );
  }

  /** RFC 7009: always 200, revoking the presented token's whole grant. */
  async revoke(body: Record<string, any>, authorization?: string) {
    const c = await this.authenticateClient(body, authorization);
    if (!body.token) return;
    const row = (
      await this.db.query('SELECT family_id, client_id FROM oauth_tokens WHERE token_hash = $1', [
        sha256(String(body.token)),
      ])
    ).rows[0];
    if (row && row.client_id === c.client_id) {
      await this.db.query(
        'UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
        [row.family_id],
      );
    }
  }

  /** Resolve an access token presented to /mcp/s/:serverId. */
  async validateAccessToken(token: string, serverId: string): Promise<OAuthBinding | undefined> {
    if (!token.startsWith('cha_')) return undefined;
    const row = (
      await this.db.query(
        `SELECT tenant_id, user_id, server_id, expires_at, revoked_at FROM oauth_tokens WHERE token_hash = $1 AND kind = 'access'`,
        [sha256(token)],
      )
    ).rows[0];
    if (
      !row ||
      row.revoked_at ||
      new Date(row.expires_at).getTime() < Date.now() ||
      row.server_id !== serverId
    )
      return undefined;
    return { tenantId: row.tenant_id, userId: row.user_id, serverId: row.server_id };
  }

  // ───────────────────────────── tenant administration ─────────────────────────────

  async listGrants(tenantId: string, userId?: string) {
    const { rows } = await this.db.query(
      `SELECT t.family_id, t.user_id, t.server_id, c.client_name, MIN(t.created_at) AS created_at, MAX(t.created_at) AS last_used_at
       FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
       WHERE t.tenant_id = $1 AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.used_at IS NULL AND t.expires_at > now()
         AND ($2::text IS NULL OR t.user_id = $2)
       GROUP BY t.family_id, t.user_id, t.server_id, c.client_name ORDER BY last_used_at DESC LIMIT 500`,
      [tenantId, userId ?? null],
    );
    return rows.map((r) => ({
      id: r.family_id,
      user_id: r.user_id,
      server_id: r.server_id,
      client_name: r.client_name,
      created_at: new Date(r.created_at).toISOString(),
      last_used_at: new Date(r.last_used_at).toISOString(),
    }));
  }

  async revokeGrant(tenantId: string, familyId: string) {
    const { rows } = await this.db.query(
      'UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING id',
      [familyId, tenantId],
    );
    if (!rows.length) throw new AppError(404, 'not_found', 'Grant not found');
  }

  async getSsoPolicy(tenantId: string) {
    const t = (
      await this.db.query('SELECT sso_allowed_domains, sso_allowed_emails FROM tenants WHERE id = $1', [
        tenantId,
      ])
    ).rows[0];
    return { allowed_domains: t?.sso_allowed_domains ?? [], allowed_emails: t?.sso_allowed_emails ?? [] };
  }

  async setSsoPolicy(tenantId: string, input: { allowed_domains?: unknown; allowed_emails?: unknown }) {
    const clean = (v: unknown, re: RegExp, what: string) => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.length > 200 || !v.every((x) => typeof x === 'string' && re.test(x))) {
        throw new AppError(400, 'bad_request', `${what} must be an array of valid values`);
      }
      return [...new Set(v.map((x: string) => x.toLowerCase().replace(/^@/, '')))];
    };
    const domains = clean(input.allowed_domains, /^@?[a-z0-9.-]+\.[a-z]{2,}$/i, 'allowed_domains');
    const emails = clean(input.allowed_emails, /^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'allowed_emails');
    if (domains)
      await this.db.query('UPDATE tenants SET sso_allowed_domains = $1 WHERE id = $2', [
        JSON.stringify(domains),
        tenantId,
      ]);
    if (emails)
      await this.db.query('UPDATE tenants SET sso_allowed_emails = $1 WHERE id = $2', [
        JSON.stringify(emails),
        tenantId,
      ]);
    return this.getSsoPolicy(tenantId);
  }
}
