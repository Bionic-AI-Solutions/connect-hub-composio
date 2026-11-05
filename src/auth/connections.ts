import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { newId, randomToken, type Vault } from '../crypto/vault.js';
import type { Registry } from '../catalog/registry.js';
import type { AuthScheme, AuthSchemeType, ConnectionValue, Toolkit } from '../catalog/types.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { PROVIDER_SETUP } from '../catalog/providers.js';

export type AccountStatus = 'ACTIVE' | 'EXPIRED' | 'FAILED';

interface AccountRow {
  id: string;
  tenant_id: string;
  user_id: string;
  toolkit: string;
  scheme: AuthSchemeType;
  auth_config_id: string | null;
  status: AccountStatus;
  credentials_enc: string | null;
  identifier: string | null;
  expires_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AuthConfigRow {
  id: string;
  tenant_id: string;
  toolkit: string;
  scheme: AuthSchemeType;
  use_platform_app: boolean;
  client_id: string | null;
  client_secret_enc: string | null;
  scopes: string[] | null;
  created_at: Date | string;
}

interface ConnectRequestRow {
  id: string;
  tenant_id: string;
  user_id: string;
  toolkit: string;
  scheme: AuthSchemeType;
  auth_config_id: string | null;
  secret_enc: string;
  redirect_url: string | null;
  expires_at: Date | string;
  completed_at: Date | string | null;
  connected_account_id: string | null;
}

interface ConnectSecret {
  codeVerifier: string;
  /** OAuth2 connection props captured before the redirect (e.g. a subdomain). */
  props?: Record<string, unknown>;
}

export type PublicAccount = Omit<AccountRow, 'credentials_enc'>;
/** One row of a tenant copy report: names only, never credentials. */
export type CopyItem = Record<string, unknown> & {
  toolkit: string;
  result: 'copied' | 'exists' | 'would_copy' | 'skipped';
};
export type PublicAuthConfig = Omit<AuthConfigRow, 'client_secret_enc'> & { has_client_secret: boolean };

const toIso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

function publicAccount(r: AccountRow): PublicAccount {
  const { credentials_enc: _omit, ...rest } = r;
  delete (rest as Record<string, unknown>).refresh_lock_until;
  return {
    ...rest,
    expires_at: toIso(r.expires_at),
    created_at: toIso(r.created_at)!,
    updated_at: toIso(r.updated_at)!,
  };
}

function publicAuthConfig(r: AuthConfigRow): PublicAuthConfig {
  const { client_secret_enc, ...rest } = r;
  return { ...rest, created_at: toIso(r.created_at)!, has_client_secret: !!client_secret_enc };
}

function fillTemplate(url: string, props: Record<string, unknown> = {}): string {
  return url.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = props[name.trim()];
    if (v === undefined || v === null || v === '') throw badRequest(`Missing connection field "${name}"`);
    return encodeURIComponent(String(v));
  });
}

export class ConnectionService {
  private readonly refreshing = new Map<string, Promise<ConnectionValue>>();

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly registry: Registry,
    private readonly config: Config,
  ) {}

  get redirectUri(): string {
    return `${this.config.PUBLIC_URL}/oauth/callback`;
  }

  // ───────────────────────────── toolkits & schemes ─────────────────────────────

  toolkit(slug: string): Toolkit {
    const tk = this.registry.getToolkit(slug);
    if (!tk) throw notFound(`Toolkit "${slug}"`);
    return tk;
  }

  scheme(tk: Toolkit, type?: string): AuthScheme {
    if (type) {
      const s = tk.authSchemes.find((x) => x.type === type);
      if (!s)
        throw badRequest(`Toolkit "${tk.slug}" does not support auth scheme ${type}`, {
          supported: tk.authSchemes.map((x) => x.type),
        });
      return s;
    }
    const preferred =
      tk.authSchemes.find((x) => x.type === 'OAUTH2') ??
      tk.authSchemes.find((x) => x.type !== 'NO_AUTH') ??
      tk.authSchemes[0];
    if (!preferred) throw badRequest(`Toolkit "${tk.slug}" has no auth schemes`);
    return preferred;
  }

  // ───────────────────────────── auth configs ─────────────────────────────

  async createAuthConfig(
    tenantId: string,
    input: {
      toolkit: string;
      scheme?: string;
      client_id?: string;
      client_secret?: string;
      scopes?: string[];
    },
  ): Promise<PublicAuthConfig> {
    const tk = this.toolkit(input.toolkit);
    const scheme = this.scheme(tk, input.scheme);
    const own = !!input.client_id;
    if (scheme.type === 'OAUTH2' && own && !input.client_secret)
      throw badRequest('client_secret is required with client_id');
    if (scheme.type !== 'OAUTH2' && (input.client_id || input.client_secret))
      throw badRequest('client_id/client_secret only apply to OAUTH2');
    const { rows } = await this.db.query<AuthConfigRow>(
      `INSERT INTO auth_configs (id, tenant_id, toolkit, scheme, use_platform_app, client_id, client_secret_enc, scopes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        newId('ac'),
        tenantId,
        tk.slug,
        scheme.type,
        !own,
        input.client_id ?? null,
        input.client_secret ? this.vault.encrypt(input.client_secret, tenantId) : null,
        input.scopes ? JSON.stringify(input.scopes) : null,
      ],
    );
    return publicAuthConfig(rows[0]);
  }

  async listAuthConfigs(tenantId: string, toolkit?: string): Promise<PublicAuthConfig[]> {
    const { rows } = await this.db.query<AuthConfigRow>(
      `SELECT * FROM auth_configs WHERE tenant_id = $1 AND ($2::text IS NULL OR toolkit = $2) ORDER BY created_at DESC`,
      [tenantId, toolkit ?? null],
    );
    return rows.map(publicAuthConfig);
  }

  async deleteAuthConfig(tenantId: string, id: string): Promise<void> {
    const { rows } = await this.db.query(
      'DELETE FROM auth_configs WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId],
    );
    if (!rows.length) throw notFound('Auth config');
  }

  // ───────────────────────────── one-time OAuth setup per provider ─────────────────────────────

  /** Toolkits whose OAuth scheme belongs to this provider family (google covers Gmail, Drive, YouTube…). */
  private providerToolkits(provider: string): Toolkit[] {
    return this.registry
      .listToolkits()
      .filter((tk) => tk.authSchemes.some((s) => s.type === 'OAUTH2' && s.oauth2?.provider === provider));
  }

  /** Toolkits that use this tenant's own OAuth app: the newest OAUTH2 config per toolkit (as sign-in resolves it). */
  private async ownOAuthApps(tenantId: string): Promise<Map<string, string>> {
    const { rows } = await this.db.query<{
      toolkit: string;
      client_id: string | null;
      use_platform_app: boolean;
    }>(
      `SELECT DISTINCT ON (toolkit) toolkit, client_id, use_platform_app FROM auth_configs
        WHERE tenant_id = $1 AND scheme = 'OAUTH2' ORDER BY toolkit, created_at DESC`,
      [tenantId],
    );
    return new Map(
      rows.filter((r) => !r.use_platform_app && r.client_id).map((r) => [r.toolkit, r.client_id!]),
    );
  }

  /** Every OAuth provider the catalog uses, whether an OAuth app is set (platform-wide or this tenant's own). */
  async oauthProviders(tenantId: string) {
    const own = await this.ownOAuthApps(tenantId);
    const providers = new Map<string, Toolkit[]>();
    for (const tk of this.registry.listToolkits())
      for (const sc of tk.authSchemes)
        if (sc.type === 'OAUTH2' && sc.oauth2)
          providers.set(sc.oauth2.provider, [...(providers.get(sc.oauth2.provider) ?? []), tk]);
    return [...providers.entries()]
      .map(([provider, tks]) => {
        const withOwn = tks.filter((tk) => own.has(tk.slug));
        const tenantClientIds = [...new Set(withOwn.map((tk) => own.get(tk.slug)!))];
        const platform = !!this.config.platformOAuthApps[provider];
        const setup = PROVIDER_SETUP[provider];
        const scopes = [
          ...new Set(
            tks.flatMap((tk) => tk.authSchemes.find((x) => x.type === 'OAUTH2')?.oauth2?.scopes ?? []),
          ),
        ];
        return {
          provider,
          name: setup?.name ?? provider,
          console_url: setup?.consoleUrl ?? null,
          note: setup?.note ?? null,
          callback_url: this.redirectUri,
          scopes,
          toolkits: tks.map((tk) => ({ slug: tk.slug, name: tk.name, uses_own_app: own.has(tk.slug) })),
          // tenant: every app uses the tenant's own OAuth app; partial: only some do (the rest use the platform app or
          // cannot sign in yet); platform / none: no own app at all.
          source:
            withOwn.length === tks.length
              ? 'tenant'
              : withOwn.length
                ? 'partial'
                : platform
                  ? 'platform'
                  : 'none',
          platform_app: platform,
          client_id: tenantClientIds.length === 1 ? tenantClientIds[0] : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async oauthProvider(tenantId: string, provider: string) {
    const p = (await this.oauthProviders(tenantId)).find((x) => x.provider === provider);
    if (!p) throw notFound(`OAuth provider "${provider}"`);
    return p;
  }

  /** Store one OAuth app for every app of a provider, so a person only enters the keys once. Each toolkit's newest
   *  OAUTH2 config is updated in place (keeping its id, so in-flight sign-ins and auth_config_id references survive, and
   *  any custom scopes); a toolkit without one gets a new row. Every write is a single statement, so concurrent saves
   *  never leave a toolkit without a config. */
  async setProviderApp(
    tenantId: string,
    provider: string,
    input: { client_id?: string; client_secret?: string },
  ) {
    const tks = this.providerToolkits(provider);
    if (!tks.length) throw notFound(`OAuth provider "${provider}"`);
    const clientId = typeof input.client_id === 'string' ? input.client_id.trim() : '';
    const clientSecret = typeof input.client_secret === 'string' ? input.client_secret.trim() : '';
    if (!clientId || !clientSecret) throw badRequest('client_id and client_secret are required');
    if (clientId.length > 500 || clientSecret.length > 2000)
      throw badRequest('client_id or client_secret is too long');
    for (const tk of tks) {
      const secretEnc = this.vault.encrypt(clientSecret, tenantId);
      const updated = await this.db.query(
        `UPDATE auth_configs SET use_platform_app = false, client_id = $3, client_secret_enc = $4
          WHERE id = (SELECT id FROM auth_configs WHERE tenant_id = $1 AND toolkit = $2 AND scheme = 'OAUTH2'
                       ORDER BY created_at DESC LIMIT 1)
            AND tenant_id = $1
          RETURNING id`,
        [tenantId, tk.slug, clientId, secretEnc],
      );
      if (!updated.rows.length)
        await this.db.query(
          `INSERT INTO auth_configs (id, tenant_id, toolkit, scheme, use_platform_app, client_id, client_secret_enc, scopes)
           VALUES ($1,$2,$3,'OAUTH2',false,$4,$5,NULL)`,
          [newId('ac'), tenantId, tk.slug, clientId, secretEnc],
        );
    }
    return this.oauthProvider(tenantId, provider);
  }

  /** Remove this tenant's own OAuth app for a provider; sign-in falls back to the platform app, if any. Configs that
   *  carry custom scopes are kept and switched to the platform app, so the scopes survive. */
  async clearProviderApp(tenantId: string, provider: string) {
    const tks = this.providerToolkits(provider);
    if (!tks.length) throw notFound(`OAuth provider "${provider}"`);
    const slugs = tks.map((tk) => tk.slug);
    await this.db.query(
      `UPDATE auth_configs SET use_platform_app = true, client_id = NULL, client_secret_enc = NULL
        WHERE tenant_id = $1 AND scheme = 'OAUTH2' AND toolkit = ANY($2::text[]) AND use_platform_app = false
          AND scopes IS NOT NULL`,
      [tenantId, slugs],
    );
    await this.db.query(
      `DELETE FROM auth_configs WHERE tenant_id = $1 AND scheme = 'OAUTH2' AND toolkit = ANY($2::text[])
          AND use_platform_app = false`,
      [tenantId, slugs],
    );
    return this.oauthProvider(tenantId, provider);
  }

  /** The app picker: every toolkit with whether it can be connected now and this person's accounts. */
  async appsOverview(tenantId: string, userId?: string) {
    const own = await this.ownOAuthApps(tenantId);
    const { rows } = await this.db.query<{ toolkit: string; status: string; n: string }>(
      `SELECT toolkit, status, count(*)::text AS n FROM connected_accounts
        WHERE tenant_id = $1 AND ($2::text IS NULL OR user_id = $2) GROUP BY toolkit, status`,
      [tenantId, userId ?? null],
    );
    const counts = new Map<string, Record<string, number>>();
    for (const r of rows)
      counts.set(r.toolkit, { ...(counts.get(r.toolkit) ?? {}), [r.status]: Number(r.n) });
    return this.registry.listToolkits().map((tk) => {
      const oauth = tk.authSchemes.find((s) => s.type === 'OAUTH2')?.oauth2;
      // Readiness per toolkit, exactly as sign-in resolves it: this tenant's own app for the toolkit, else the platform's.
      const oauthSource = !oauth
        ? null
        : own.has(tk.slug)
          ? 'tenant'
          : this.config.platformOAuthApps[oauth.provider]
            ? 'platform'
            : 'none';
      const other = tk.authSchemes
        .filter((s) => s.type !== 'OAUTH2' && s.type !== 'NO_AUTH')
        .map((s) => s.type);
      const oauthReady = oauthSource === 'tenant' || oauthSource === 'platform';
      const c = counts.get(tk.slug) ?? {};
      return {
        slug: tk.slug,
        name: tk.name,
        logo_url: tk.logoUrl ?? null,
        categories: tk.categories,
        tool_count: tk.tools.length,
        // How "Connect" signs in: the provider's sign-in page, a form (API key, token…), or nothing at all.
        connect: oauthReady
          ? 'oauth'
          : other.length
            ? 'form'
            : tk.authSchemes.some((s) => s.type === 'NO_AUTH')
              ? 'none'
              : 'setup_required',
        oauth_provider: oauth?.provider ?? null,
        oauth_source: oauthSource,
        other_schemes: other,
        accounts: { active: c.ACTIVE ?? 0, needs_attention: (c.EXPIRED ?? 0) + (c.FAILED ?? 0) },
      };
    });
  }

  private async oauthClient(tenantId: string, tk: Toolkit, scheme: AuthScheme, authConfigId?: string | null) {
    let cfg: AuthConfigRow | undefined;
    if (authConfigId) {
      cfg = (
        await this.db.query<AuthConfigRow>('SELECT * FROM auth_configs WHERE id = $1 AND tenant_id = $2', [
          authConfigId,
          tenantId,
        ])
      ).rows[0];
      if (!cfg || cfg.toolkit !== tk.slug) throw notFound('Auth config');
    } else {
      cfg = (
        await this.db.query<AuthConfigRow>(
          `SELECT * FROM auth_configs WHERE tenant_id = $1 AND toolkit = $2 AND scheme = 'OAUTH2' ORDER BY created_at DESC LIMIT 1`,
          [tenantId, tk.slug],
        )
      ).rows[0];
    }
    const scopes = cfg?.scopes?.length ? cfg.scopes : scheme.oauth2!.scopes;
    if (cfg && !cfg.use_platform_app && cfg.client_id && cfg.client_secret_enc) {
      const clientSecret = this.vault.decrypt<string>(cfg.client_secret_enc, tenantId);
      if (this.vault.isStale(cfg.client_secret_enc)) {
        // Upgrade older envelopes to the tenant-scoped format (conditional, so concurrent upgrades are harmless).
        await this.db.query(
          'UPDATE auth_configs SET client_secret_enc = $1 WHERE id = $2 AND client_secret_enc = $3',
          [this.vault.encrypt(clientSecret, tenantId), cfg.id, cfg.client_secret_enc],
        );
      }
      return {
        clientId: cfg.client_id,
        clientSecret,
        scopes,
        authConfigId: cfg.id,
      };
    }
    const platform = this.config.platformOAuthApps[scheme.oauth2!.provider];
    if (!platform) {
      throw new AppError(
        409,
        'oauth_app_missing',
        `${tk.name} sign-in is not set up yet. An admin sets it up once in the Connect Hub dashboard (Apps → ${tk.name} → Set up), or the operator sets OAUTH_${scheme.oauth2!.provider.toUpperCase().replace(/-/g, '_')}_CLIENT_ID/SECRET for every tenant.`,
      );
    }
    return {
      clientId: platform.clientId,
      clientSecret: platform.clientSecret,
      scopes,
      authConfigId: cfg?.id ?? null,
    };
  }

  // ───────────────────────────── hosted connect flow ─────────────────────────────

  private checkRedirect(url?: string) {
    if (!url) return;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw badRequest('redirect_url is not a valid URL');
    }
    const isLocal = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
    // Back to the hub's own dashboard only. Any other hub path could chain onward (e.g. /oauth2/authorize).
    const isHub =
      u.origin === new URL(this.config.PUBLIC_URL).origin &&
      u.pathname === '/dashboard' &&
      !u.username &&
      !u.password;
    if (!isLocal && !isHub && !this.config.allowedRedirectOrigins.includes(u.origin)) {
      throw badRequest(`redirect_url origin ${u.origin} is not in ALLOWED_REDIRECT_ORIGINS`);
    }
  }

  async createConnectLink(
    tenantId: string,
    input: {
      user_id: string;
      toolkit: string;
      scheme?: string;
      auth_config_id?: string;
      redirect_url?: string;
    },
  ): Promise<{ id: string; connect_url: string; expires_at: string; scheme: AuthSchemeType }> {
    if (!input.user_id) throw badRequest('user_id is required');
    const tk = this.toolkit(input.toolkit);
    const scheme = this.scheme(tk, input.scheme);
    if (scheme.type === 'NO_AUTH')
      throw badRequest(`Toolkit "${tk.slug}" needs no connection for ${scheme.type}`);
    this.checkRedirect(input.redirect_url);
    if (scheme.type === 'OAUTH2') await this.oauthClient(tenantId, tk, scheme, input.auth_config_id); // fail fast if no app
    const id = newId('cr');
    const expires = new Date(Date.now() + this.config.CONNECT_LINK_TTL_MINUTES * 60_000);
    const secret: ConnectSecret = { codeVerifier: randomToken(48) };
    await this.db.query(
      `INSERT INTO connect_requests (id, tenant_id, user_id, toolkit, scheme, auth_config_id, secret_enc, redirect_url, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        tenantId,
        input.user_id,
        tk.slug,
        scheme.type,
        input.auth_config_id ?? null,
        this.vault.encrypt(secret, tenantId),
        input.redirect_url ?? null,
        expires,
      ],
    );
    return {
      id,
      connect_url: `${this.config.PUBLIC_URL}/connect/${id}?sig=${this.vault.sign(`link:${id}`)}`,
      expires_at: expires.toISOString(),
      scheme: scheme.type,
    };
  }

  /** Load an open connect request; `sig` is the link signature from the URL. */
  async openConnectRequest(
    id: string,
    sig: string,
  ): Promise<{ req: ConnectRequestRow; toolkit: Toolkit; scheme: AuthScheme }> {
    if (!sig || !this.vault.verify(`link:${id}`, sig))
      throw new AppError(403, 'invalid_link', 'This connect link is invalid');
    return this.loadOpenRequest(id);
  }

  private async loadOpenRequest(id: string) {
    const req = (await this.db.query<ConnectRequestRow>('SELECT * FROM connect_requests WHERE id = $1', [id]))
      .rows[0];
    if (!req) throw new AppError(404, 'invalid_link', 'This connect link does not exist');
    if (req.completed_at) throw new AppError(410, 'link_used', 'This connect link has already been used');
    if (new Date(req.expires_at).getTime() < Date.now())
      throw new AppError(410, 'link_expired', 'This connect link has expired');
    const toolkit = this.toolkit(req.toolkit);
    return { req, toolkit, scheme: this.scheme(toolkit, req.scheme) };
  }

  /** Build the provider authorize URL for an OAuth2 connect request. */
  async authorizeUrl(id: string, sig: string, props: Record<string, unknown> = {}): Promise<string> {
    const { req, toolkit, scheme } = await this.openConnectRequest(id, sig);
    if (scheme.type !== 'OAUTH2' || !scheme.oauth2) throw badRequest('Not an OAuth2 connect request');
    const missing = scheme.fields.filter(
      (f) => f.required && (props[f.name] === undefined || props[f.name] === ''),
    );
    if (missing.length) throw badRequest(`Missing: ${missing.map((f) => f.displayName).join(', ')}`);
    const secret = this.vault.decrypt<ConnectSecret>(req.secret_enc, req.tenant_id);
    if (scheme.fields.length) {
      secret.props = Object.fromEntries(scheme.fields.map((f) => [f.name, props[f.name]]));
      await this.db.query('UPDATE connect_requests SET secret_enc = $1 WHERE id = $2', [
        this.vault.encrypt(secret, req.tenant_id),
        id,
      ]);
    }
    const client = await this.oauthClient(req.tenant_id, toolkit, scheme, req.auth_config_id);
    const o = scheme.oauth2;
    const url = new URL(fillTemplate(o.authUrl, secret.props));
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    if (client.scopes.length) {
      // Slack keeps bot scopes in `scope`; the piece already embeds user_scope in the authUrl.
      url.searchParams.set('scope', client.scopes.join(o.provider === 'facebook' ? ',' : ' '));
    }
    url.searchParams.set('state', `${id}.${this.vault.sign(`state:${id}`)}`);
    for (const [k, v] of Object.entries(o.authorizeParams)) url.searchParams.set(k, v);
    if (o.pkce) {
      const challenge =
        o.pkceMethod === 'plain'
          ? secret.codeVerifier
          : createHash('sha256').update(secret.codeVerifier).digest('base64url');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', o.pkceMethod);
    }
    return url.toString();
  }

  private async tokenRequest(
    tokenUrl: string,
    params: Record<string, string>,
    client: { clientId: string; clientSecret: string },
    spec: { clientAuth: 'body' | 'header'; tokenFormat?: 'form' | 'json' },
  ): Promise<Record<string, any>> {
    const json = spec.tokenFormat === 'json';
    const headers: Record<string, string> = {
      'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    const fields: Record<string, string> = { ...params };
    if (spec.clientAuth === 'header') {
      headers.authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;
    } else {
      fields.client_id = client.clientId;
      fields.client_secret = client.clientSecret;
    }
    const body = json ? JSON.stringify(fields) : new URLSearchParams(fields);
    // Bounded well inside the refresh lease, so a slow provider cannot outlive the lease (see refreshWithLease).
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.tokenTimeoutMs),
    });
    const text = await res.text();
    let data: Record<string, any>;
    try {
      data = JSON.parse(text);
    } catch {
      data = Object.fromEntries(new URLSearchParams(text));
    }
    if (!res.ok || data.error || data.ok === false) {
      const reason = data.error_description || data.error || `HTTP ${res.status}`;
      throw new AppError(
        502,
        data.error === 'invalid_grant' ? 'invalid_grant' : 'oauth_token_error',
        `Token endpoint rejected the request: ${reason}`,
      );
    }
    return data;
  }

  /** Complete an OAuth2 flow from the provider callback. Returns the request (for the redirect) and the account. */
  /** Where a sign-in started from, for sending the person back after a failure. Trusts only a signed state; the
   *  redirect_url was validated when the link was created. */
  async redirectForState(state: string): Promise<string | null> {
    const [id, sig] = String(state ?? '').split('.');
    if (!id || !sig || !this.vault.verify(`state:${id}`, sig)) return null;
    const { rows } = await this.db.query<{ redirect_url: string | null }>(
      'SELECT redirect_url FROM connect_requests WHERE id = $1',
      [id],
    );
    return rows[0]?.redirect_url ?? null;
  }

  async completeOAuth(
    state: string,
    code: string,
  ): Promise<{ redirectUrl: string | null; account: PublicAccount }> {
    const [id, sig] = String(state ?? '').split('.');
    if (!id || !sig || !this.vault.verify(`state:${id}`, sig))
      throw new AppError(403, 'invalid_state', 'Invalid OAuth state');
    const { req, toolkit, scheme } = await this.loadOpenRequest(id);
    const secret = this.vault.decrypt<ConnectSecret>(req.secret_enc, req.tenant_id);
    const client = await this.oauthClient(req.tenant_id, toolkit, scheme, req.auth_config_id);
    const o = scheme.oauth2!;
    const tokenUrl = fillTemplate(o.tokenUrl, secret.props);
    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    };
    if (o.pkce) params.code_verifier = secret.codeVerifier;
    const data = await this.tokenRequest(tokenUrl, params, client, o);
    const accessToken = data.access_token ?? data.authed_user?.access_token;
    if (!accessToken) throw new AppError(502, 'oauth_token_error', 'Token response had no access_token');
    const value: ConnectionValue = {
      type: 'OAUTH2',
      access_token: accessToken,
      refresh_token: data.refresh_token,
      token_type: data.token_type,
      expires_in: data.expires_in ? Number(data.expires_in) : undefined,
      claimed_at: Math.floor(Date.now() / 1000),
      scope: data.scope ?? client.scopes.join(' '),
      client_id: client.clientId,
      client_secret: client.clientSecret,
      token_url: tokenUrl,
      redirect_url: this.redirectUri,
      data,
      props: secret.props,
    };
    const account = await this.storeAccount(
      req.tenant_id,
      req.user_id,
      toolkit,
      'OAUTH2',
      value,
      client.authConfigId,
    );
    await this.markCompleted(req.id, account.id);
    return { redirectUrl: req.redirect_url, account };
  }

  /** Complete a credential-form connect request (API key, basic auth, custom fields). */
  async completeForm(
    id: string,
    sig: string,
    fields: Record<string, unknown>,
  ): Promise<{ redirectUrl: string | null; account: PublicAccount }> {
    const { req, toolkit, scheme } = await this.openConnectRequest(id, sig);
    if (scheme.type === 'OAUTH2') throw badRequest('Use the OAuth flow for this request');
    const account = await this.createAccount(req.tenant_id, {
      user_id: req.user_id,
      toolkit: toolkit.slug,
      scheme: scheme.type,
      credentials: fields,
    });
    await this.markCompleted(req.id, account.id);
    return { redirectUrl: req.redirect_url, account };
  }

  private async markCompleted(requestId: string, accountId: string) {
    // Wipe the PKCE verifier once used.
    await this.db.query(
      `UPDATE connect_requests SET completed_at = now(), connected_account_id = $1, secret_enc = '' WHERE id = $2`,
      [accountId, requestId],
    );
  }

  // ───────────────────────────── connected accounts ─────────────────────────────

  private credentialValue(scheme: AuthScheme, fields: Record<string, unknown>): ConnectionValue {
    const missing = scheme.fields.filter(
      (f) => f.required && (fields[f.name] === undefined || fields[f.name] === null || fields[f.name] === ''),
    );
    if (missing.length)
      throw badRequest(`Missing credential field(s): ${missing.map((f) => f.name).join(', ')}`);
    const pick = () => {
      const out: Record<string, unknown> = {};
      for (const f of scheme.fields) {
        let v = fields[f.name] ?? f.defaultValue;
        if (f.type === 'number' && typeof v === 'string' && v !== '') v = Number(v);
        if (f.type === 'boolean' && typeof v === 'string') v = v === 'true' || v === 'on';
        if (v !== undefined) out[f.name] = v;
      }
      return out;
    };
    switch (scheme.type) {
      case 'SECRET_TEXT':
        return { type: 'SECRET_TEXT', secret_text: String(fields.secret_text) };
      case 'BASIC_AUTH':
        return { type: 'BASIC_AUTH', username: String(fields.username), password: String(fields.password) };
      case 'CUSTOM_AUTH':
        return { type: 'CUSTOM_AUTH', props: pick() };
      default:
        throw badRequest(`Cannot create ${scheme.type} accounts from credentials`);
    }
  }

  /** Create a non-OAuth account directly from credentials (server-to-server import). Credentials are validated first. */
  async createAccount(
    tenantId: string,
    input: { user_id: string; toolkit: string; scheme?: string; credentials: Record<string, unknown> },
  ): Promise<PublicAccount> {
    if (!input.user_id) throw badRequest('user_id is required');
    const tk = this.toolkit(input.toolkit);
    const scheme = this.scheme(
      tk,
      input.scheme ?? tk.authSchemes.find((s) => s.type !== 'OAUTH2' && s.type !== 'NO_AUTH')?.type,
    );
    const value = this.credentialValue(scheme, input.credentials ?? {});
    if (tk.validate) {
      const res = await tk.validate(value);
      if (!res.valid)
        throw new AppError(
          422,
          'invalid_credentials',
          res.error ?? 'Credentials were rejected by the provider',
        );
    }
    return this.storeAccount(tenantId, input.user_id, tk, scheme.type, value, null);
  }

  private async storeAccount(
    tenantId: string,
    userId: string,
    tk: Toolkit,
    scheme: AuthSchemeType,
    value: ConnectionValue,
    authConfigId: string | null,
  ): Promise<PublicAccount> {
    const identifier = tk.identify ? await tk.identify(value) : undefined;
    const expiresAt =
      value.type === 'OAUTH2' && value.expires_in
        ? new Date((value.claimed_at + value.expires_in) * 1000)
        : null;
    const { rows } = await this.db.query<AccountRow>(
      `INSERT INTO connected_accounts (id, tenant_id, user_id, toolkit, scheme, auth_config_id, status, credentials_enc, identifier, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8,$9) RETURNING *`,
      [
        newId('ca'),
        tenantId,
        userId,
        tk.slug,
        scheme,
        authConfigId,
        this.vault.encrypt(value, tenantId),
        identifier ?? null,
        expiresAt,
      ],
    );
    return publicAccount(rows[0]);
  }

  async listAccounts(
    tenantId: string,
    f: { user_id?: string; toolkit?: string; status?: string } = {},
  ): Promise<PublicAccount[]> {
    const { rows } = await this.db.query<AccountRow>(
      `SELECT * FROM connected_accounts WHERE tenant_id = $1
         AND ($2::text IS NULL OR user_id = $2) AND ($3::text IS NULL OR toolkit = $3) AND ($4::text IS NULL OR status = $4)
       ORDER BY created_at DESC LIMIT 500`,
      [tenantId, f.user_id ?? null, f.toolkit ?? null, f.status ?? null],
    );
    return rows.map(publicAccount);
  }

  private async row(tenantId: string, id: string): Promise<AccountRow> {
    const r = (
      await this.db.query<AccountRow>('SELECT * FROM connected_accounts WHERE id = $1 AND tenant_id = $2', [
        id,
        tenantId,
      ])
    ).rows[0];
    if (!r) throw notFound('Connected account');
    return r;
  }

  async getAccount(tenantId: string, id: string): Promise<PublicAccount> {
    return publicAccount(await this.row(tenantId, id));
  }

  /**
   * Operator copy of one tenant's OAuth apps and ACTIVE connected accounts into another tenant, for clients
   * that use the same underlying app accounts. Secrets are decrypted with the source tenant's key and
   * re-encrypted with the target's (a raw row copy would not decrypt). Idempotent: an auth config with the
   * same toolkit, scheme and client, or an ACTIVE account with the same user, toolkit and identifier, already
   * in the target (or earlier in this run) is reused, not duplicated, so a run that fails part-way is fixed by
   * running it again. Triggers and per-account state (kv_store) are not copied.
   * The result names what was copied; it never contains credentials.
   */
  async copyFromTenant(
    targetTenantId: string,
    sourceTenantId: string,
    opts: { toolkits?: string[]; userMap?: Record<string, string>; dryRun?: boolean } = {},
  ): Promise<{ auth_configs: CopyItem[]; accounts: CopyItem[] }> {
    if (targetTenantId === sourceTenantId) throw badRequest('source and target tenant are the same');
    const want = (toolkit: string) => !opts.toolkits?.length || opts.toolkits.includes(toolkit);
    const userMap = opts.userMap ?? {};
    const mapUser = (u: string) => (Object.hasOwn(userMap, u) ? userMap[u] : u);
    const authConfigs: CopyItem[] = [];
    const accounts: CopyItem[] = [];

    // Source config id -> target config id. A key already handled in this run maps to the same target row,
    // so a dry run reports what a real run would do when two source rows collide.
    const configMap = new Map<string, string | null>();
    const configByKey = new Map<string, string | null>();
    const { rows: srcConfigs } = await this.db.query<AuthConfigRow>(
      'SELECT * FROM auth_configs WHERE tenant_id = $1 ORDER BY created_at',
      [sourceTenantId],
    );
    for (const c of srcConfigs.filter((r) => want(r.toolkit))) {
      const item = { toolkit: c.toolkit, scheme: c.scheme, own_app: !c.use_platform_app };
      const key = JSON.stringify([c.toolkit, c.scheme, c.use_platform_app, c.client_id]);
      if (configByKey.has(key)) {
        configMap.set(c.id, configByKey.get(key)!);
        authConfigs.push({ ...item, result: 'exists' });
        continue;
      }
      const { rows: existing } = await this.db.query<{ id: string }>(
        `SELECT id FROM auth_configs WHERE tenant_id = $1 AND toolkit = $2 AND scheme = $3
           AND use_platform_app = $4 AND client_id IS NOT DISTINCT FROM $5 ORDER BY created_at DESC LIMIT 1`,
        [targetTenantId, c.toolkit, c.scheme, c.use_platform_app, c.client_id],
      );
      let targetId: string | null;
      if (existing[0]) {
        targetId = existing[0].id;
        authConfigs.push({ ...item, result: 'exists' });
      } else if (opts.dryRun) {
        targetId = null;
        authConfigs.push({ ...item, result: 'would_copy' });
      } else {
        targetId = newId('ac');
        const secretEnc = c.client_secret_enc
          ? this.vault.encrypt(
              this.vault.decrypt<string>(c.client_secret_enc, sourceTenantId),
              targetTenantId,
            )
          : null;
        await this.db.query(
          `INSERT INTO auth_configs (id, tenant_id, toolkit, scheme, use_platform_app, client_id, client_secret_enc, scopes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            targetId,
            targetTenantId,
            c.toolkit,
            c.scheme,
            c.use_platform_app,
            c.client_id,
            secretEnc,
            c.scopes ? JSON.stringify(c.scopes) : null,
          ],
        );
        authConfigs.push({ ...item, result: 'copied' });
      }
      configByKey.set(key, targetId);
      configMap.set(c.id, targetId);
    }

    const seenAccounts = new Set<string>();
    const { rows: srcAccounts } = await this.db.query<AccountRow>(
      `SELECT * FROM connected_accounts WHERE tenant_id = $1 AND status = 'ACTIVE' ORDER BY created_at`,
      [sourceTenantId],
    );
    for (const a of srcAccounts.filter((r) => want(r.toolkit))) {
      const userId = mapUser(a.user_id);
      const item = {
        toolkit: a.toolkit,
        user_id: userId,
        identifier: a.identifier,
        // OAuth copies share one refresh token; with a provider that rotates it, only one tenant keeps it.
        ...(a.scheme === 'OAUTH2' ? { shares_refresh_token: true } : {}),
      };
      const key = JSON.stringify([userId, a.toolkit, a.identifier]);
      if (seenAccounts.has(key)) {
        accounts.push({ ...item, result: 'exists' });
        continue;
      }
      seenAccounts.add(key);
      if (!a.credentials_enc) {
        accounts.push({ ...item, result: 'skipped', reason: 'no stored credentials' });
        continue;
      }
      const { rows: existing } = await this.db.query<{ id: string }>(
        `SELECT id FROM connected_accounts WHERE tenant_id = $1 AND user_id = $2 AND toolkit = $3
           AND status = 'ACTIVE' AND identifier IS NOT DISTINCT FROM $4 LIMIT 1`,
        [targetTenantId, userId, a.toolkit, a.identifier],
      );
      if (existing[0]) {
        accounts.push({ ...item, result: 'exists' });
        continue;
      }
      if (opts.dryRun) {
        accounts.push({ ...item, result: 'would_copy' });
        continue;
      }
      const value = this.vault.decrypt<ConnectionValue>(a.credentials_enc, sourceTenantId);
      const id = newId('ca');
      await this.db.query(
        `INSERT INTO connected_accounts (id, tenant_id, user_id, toolkit, scheme, auth_config_id, status, credentials_enc, identifier, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8,$9)`,
        [
          id,
          targetTenantId,
          userId,
          a.toolkit,
          a.scheme,
          a.auth_config_id ? (configMap.get(a.auth_config_id) ?? null) : null,
          this.vault.encrypt(value, targetTenantId),
          a.identifier,
          a.expires_at,
        ],
      );
      await this.db.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, toolkit, tool, connected_account_id, status)
         VALUES ($1,$2,'account.copied',$3,$4,$5,'ok')`,
        [targetTenantId, userId, a.toolkit, `from:${sourceTenantId}`, id],
      );
      accounts.push({ ...item, result: 'copied' });
    }
    if (!opts.dryRun) {
      const count = (xs: CopyItem[]) => xs.filter((x) => x.result === 'copied').length;
      await this.db.query(
        `INSERT INTO audit_log (tenant_id, action, tool, status, error) VALUES ($1,'tenant.copy',$2,'ok',$3)`,
        [
          targetTenantId,
          `from:${sourceTenantId}`,
          `copied ${count(authConfigs)} auth configs, ${count(accounts)} accounts`,
        ],
      );
    }
    return { auth_configs: authConfigs, accounts };
  }

  async deleteAccount(tenantId: string, id: string): Promise<void> {
    await this.row(tenantId, id);
    await this.db.query('DELETE FROM connected_accounts WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    await this.db.query('DELETE FROM kv_store WHERE tenant_id = $1 AND scope = $2', [tenantId, id]);
  }

  /**
   * Resolve the credential to run a tool with. Picks the given account, or the user's most recent ACTIVE account for
   * the toolkit. Refreshes OAuth tokens that expire within 5 minutes.
   */
  async credentialFor(
    tenantId: string,
    userId: string,
    toolkitSlug: string,
    accountId?: string,
  ): Promise<{ account: PublicAccount; value: ConnectionValue } | null> {
    let row: AccountRow | undefined;
    if (accountId) {
      row = await this.row(tenantId, accountId);
      if (row.user_id !== userId)
        throw new AppError(403, 'forbidden', 'Connected account belongs to a different user');
      if (row.toolkit !== toolkitSlug)
        throw badRequest(`Connected account is for "${row.toolkit}", not "${toolkitSlug}"`);
    } else {
      row = (
        await this.db.query<AccountRow>(
          `SELECT * FROM connected_accounts WHERE tenant_id = $1 AND user_id = $2 AND toolkit = $3 AND status = 'ACTIVE'
           ORDER BY created_at DESC LIMIT 1`,
          [tenantId, userId, toolkitSlug],
        )
      ).rows[0];
      if (!row) return null;
    }
    if (row.status !== 'ACTIVE') {
      throw new AppError(
        409,
        'account_not_active',
        `Connected account ${row.id} is ${row.status}${row.last_error ? `: ${row.last_error}` : ''}. Reconnect it.`,
      );
    }
    let value = this.vault.decrypt<ConnectionValue>(row.credentials_enc!, row.tenant_id);
    if (
      value.type === 'OAUTH2' &&
      row.expires_at &&
      new Date(row.expires_at).getTime() - Date.now() < 5 * 60_000
    ) {
      value = await this.refresh(row, value);
    }
    if (this.vault.isStale(row.credentials_enc!)) {
      // Conditional: never overwrite credentials another replica stored after we read the row.
      await this.db.query(
        'UPDATE connected_accounts SET credentials_enc = $1 WHERE id = $2 AND credentials_enc = $3',
        [this.vault.encrypt(value, row.tenant_id), row.id, row.credentials_enc],
      );
    }
    return { account: publicAccount(row), value };
  }

  async forceRefresh(tenantId: string, id: string): Promise<PublicAccount> {
    const row = await this.row(tenantId, id);
    const value = this.vault.decrypt<ConnectionValue>(row.credentials_enc!, row.tenant_id);
    if (value.type !== 'OAUTH2') throw badRequest('Only OAuth2 accounts can be refreshed');
    await this.refresh(row, value, true);
    return this.getAccount(tenantId, id);
  }

  private refresh(
    row: AccountRow,
    _value: Extract<ConnectionValue, { type: 'OAUTH2' }>,
    force = false,
  ): Promise<ConnectionValue> {
    // One in-flight refresh per account per process (cheap), plus a database lease so replicas never refresh the
    // same account at the same time. Refresh tokens are often single-use.
    const existing = this.refreshing.get(row.id);
    if (existing) return existing;
    const p = this.refreshWithLease(row.id, force).finally(() => this.refreshing.delete(row.id));
    this.refreshing.set(row.id, p);
    return p;
  }

  private static readonly LEASE_WAIT_MS = 15_000;
  /** Lease length. Must stay well above tokenTimeoutMs so a refresh never outlives its lease. */
  leaseSeconds = 30;
  /** Token endpoint timeout. */
  tokenTimeoutMs = 15_000;

  private async refreshWithLease(accountId: string, force: boolean): Promise<ConnectionValue> {
    const deadline = Date.now() + ConnectionService.LEASE_WAIT_MS;
    // A forced refresh that had to wait for another replica's refresh does not refresh again.
    for (let attempt = 0; ; attempt++) {
      const leased = (
        await this.db.query<AccountRow & { refresh_lock_until: Date | string }>(
          `UPDATE connected_accounts SET refresh_lock_until = now() + make_interval(secs => $2)
           WHERE id = $1 AND (refresh_lock_until IS NULL OR refresh_lock_until < now()) RETURNING *`,
          [accountId, this.leaseSeconds],
        )
      ).rows[0];
      if (leased) {
        try {
          return await this.refreshLeased(leased, force && attempt === 0);
        } finally {
          // Release only our own lease: if it expired and another replica took it, leave theirs alone.
          await this.db.query(
            'UPDATE connected_accounts SET refresh_lock_until = NULL WHERE id = $1 AND refresh_lock_until = $2',
            [accountId, leased.refresh_lock_until],
          );
        }
      }
      // Another replica holds the lease: wait for it, then use whatever it stored.
      if (Date.now() > deadline) {
        throw new AppError(
          503,
          'refresh_busy',
          'A token refresh for this account is still running; retry shortly',
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Runs while holding the lease, on a freshly read row (another replica may have refreshed already). */
  private async refreshLeased(row: AccountRow, force: boolean): Promise<ConnectionValue> {
    if (row.status !== 'ACTIVE') {
      throw new AppError(
        409,
        'account_not_active',
        `Connected account ${row.id} is ${row.status}. Reconnect it.`,
      );
    }
    const value = this.vault.decrypt<ConnectionValue>(row.credentials_enc!, row.tenant_id);
    if (value.type !== 'OAUTH2') return value;
    const fresh = !row.expires_at || new Date(row.expires_at).getTime() - Date.now() > 5 * 60_000;
    if (fresh && !force) return value;
    return this.doRefresh(row, value);
  }

  private async doRefresh(
    row: AccountRow,
    value: Extract<ConnectionValue, { type: 'OAUTH2' }>,
  ): Promise<ConnectionValue> {
    if (!value.refresh_token) {
      await this.db.query(
        `UPDATE connected_accounts SET status = 'EXPIRED', last_error = $1, updated_at = now() WHERE id = $2`,
        ['Token expired and the provider issued no refresh token', row.id],
      );
      throw new AppError(409, 'account_not_active', `Connected account ${row.id} has expired. Reconnect it.`);
    }
    const tk = this.toolkit(row.toolkit);
    const scheme = this.scheme(tk, 'OAUTH2');
    try {
      const data = await this.tokenRequest(
        value.token_url,
        { grant_type: 'refresh_token', refresh_token: value.refresh_token },
        { clientId: value.client_id, clientSecret: value.client_secret },
        scheme.oauth2!,
      );
      const next: ConnectionValue = {
        ...value,
        access_token: data.access_token ?? value.access_token,
        refresh_token: data.refresh_token ?? value.refresh_token,
        expires_in: data.expires_in ? Number(data.expires_in) : value.expires_in,
        claimed_at: Math.floor(Date.now() / 1000),
        scope: data.scope ?? value.scope,
        data: { ...value.data, ...data },
      };
      const expiresAt = next.expires_in ? new Date((next.claimed_at + next.expires_in) * 1000) : null;
      await this.db.query(
        `UPDATE connected_accounts SET credentials_enc = $1, expires_at = $2, status = 'ACTIVE', last_error = NULL,
           updated_at = now() WHERE id = $3`,
        [this.vault.encrypt(next, row.tenant_id), expiresAt, row.id],
      );
      return next;
    } catch (e) {
      const err = e as AppError;
      if (err.code === 'invalid_grant') {
        // Only expire the account if nobody stored new credentials meanwhile. With rotating refresh tokens, an
        // invalid_grant can simply mean another replica already used this refresh token successfully.
        const expired = await this.db.query(
          `UPDATE connected_accounts SET status = 'EXPIRED', last_error = $1, updated_at = now()
           WHERE id = $2 AND credentials_enc = $3 RETURNING id`,
          [err.message, row.id, row.credentials_enc],
        );
        if (!expired.rows.length) {
          const current = (
            await this.db.query<AccountRow>('SELECT * FROM connected_accounts WHERE id = $1', [row.id])
          ).rows[0];
          if (current?.status === 'ACTIVE' && current.credentials_enc) {
            return this.vault.decrypt<ConnectionValue>(current.credentials_enc, current.tenant_id);
          }
        }
        throw new AppError(
          409,
          'account_not_active',
          `Connected account ${row.id} was revoked or expired. Reconnect it.`,
        );
      }
      await this.db.query(`UPDATE connected_accounts SET last_error = $1, updated_at = now() WHERE id = $2`, [
        err.message,
        row.id,
      ]);
      throw e;
    }
  }

  /** Background job: refresh OAuth tokens expiring in the next 15 minutes. */
  async sweepExpiring(): Promise<{ refreshed: number; failed: number }> {
    const { rows } = await this.db.query<AccountRow>(
      `SELECT * FROM connected_accounts WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at < now() + interval '15 minutes' LIMIT 200`,
    );
    let refreshed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const value = this.vault.decrypt<ConnectionValue>(row.credentials_enc!, row.tenant_id);
        if (value.type !== 'OAUTH2') continue;
        await this.refresh(row, value);
        refreshed++;
      } catch {
        failed++;
      }
    }
    return { refreshed, failed };
  }
}
