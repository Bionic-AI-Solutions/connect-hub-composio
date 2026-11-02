/**
 * Minimal OIDC relying party for signing people in (Keycloak or any OpenID provider).
 *
 * The ID token is obtained directly from the provider's token endpoint over TLS (authorization code + PKCE), so per
 * OIDC Core §3.1.3.7 its issuer/audience/nonce/expiry claims are checked and TLS stands in for the signature check.
 */
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

export interface OidcIdentity {
  sub: string;
  email: string;
  name?: string;
}

export class OidcClient {
  private discovery?: Promise<Discovery>;

  constructor(private readonly config: Config) {}

  get enabled(): boolean {
    return !!(this.config.OIDC_ISSUER && this.config.OIDC_CLIENT_ID && this.config.OIDC_CLIENT_SECRET);
  }

  get redirectUri(): string {
    return `${this.config.PUBLIC_URL}/oauth2/callback`;
  }

  private issuer(): string {
    return this.config.OIDC_ISSUER!.replace(/\/+$/, '');
  }

  private discover(): Promise<Discovery> {
    if (!this.enabled)
      throw new AppError(503, 'sso_not_configured', 'Single sign-on is not configured on this hub');
    this.discovery ??= (async () => {
      const res = await fetch(`${this.issuer()}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
      const d = (await res.json()) as Discovery;
      if (d.issuer.replace(/\/+$/, '') !== this.issuer()) throw new Error('OIDC discovery issuer mismatch');
      return d;
    })().catch((e) => {
      this.discovery = undefined; // retry next time
      throw new AppError(502, 'sso_unavailable', `Sign-in provider unavailable: ${(e as Error).message}`);
    });
    return this.discovery;
  }

  async authorizeUrl(state: string, nonce: string, verifier: string, loginHint?: string): Promise<string> {
    const d = await this.discover();
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('client_id', this.config.OIDC_CLIENT_ID!);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    u.searchParams.set('code_challenge_method', 'S256');
    if (loginHint) u.searchParams.set('login_hint', loginHint);
    return u.toString();
  }

  async exchange(code: string, verifier: string, nonce: string): Promise<OidcIdentity> {
    const d = await this.discover();
    const res = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.config.OIDC_CLIENT_ID!,
        client_secret: this.config.OIDC_CLIENT_SECRET!,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !data.id_token) {
      throw new AppError(
        502,
        'sso_failed',
        `Sign-in failed: ${data.error_description ?? data.error ?? `HTTP ${res.status}`}`,
      );
    }
    const claims = decodeJwtPayload(String(data.id_token));
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (String(claims.iss).replace(/\/+$/, '') !== this.issuer())
      throw new AppError(502, 'sso_failed', 'ID token issuer mismatch');
    if (!aud.includes(this.config.OIDC_CLIENT_ID))
      throw new AppError(502, 'sso_failed', 'ID token audience mismatch');
    if (claims.nonce !== nonce) throw new AppError(502, 'sso_failed', 'ID token nonce mismatch');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() - 60_000) {
      throw new AppError(502, 'sso_failed', 'ID token expired');
    }
    if (!claims.email || claims.email_verified === false) {
      throw new AppError(403, 'email_unverified', 'Your account needs a verified email address');
    }
    return { sub: String(claims.sub), email: String(claims.email).toLowerCase(), name: claims.name };
  }
}

export function decodeJwtPayload(jwt: string): Record<string, any> {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new AppError(502, 'sso_failed', 'Malformed ID token');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new AppError(502, 'sso_failed', 'Malformed ID token');
  }
}
