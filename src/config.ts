import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Externally reachable base URL. OAuth redirect URIs are derived from it. */
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  /** postgres://… for production, `pglite:<dir>` for a file-backed embedded db, `pglite:memory` for tests. */
  DATABASE_URL: z.string().default('pglite:./data/pglite'),
  /**
   * Comma-separated `<keyId>:<base64 32-byte key>` list. The FIRST entry encrypts new data;
   * the rest stay valid for decryption so keys can be rotated without downtime.
   */
  MASTER_KEYS: z.string().min(1, 'MASTER_KEYS is required (see .env.example)'),
  /** Bearer token for /admin endpoints (tenant provisioning). */
  ADMIN_TOKEN: z.string().min(24, 'ADMIN_TOKEN must be at least 24 characters'),
  CONNECT_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  REFRESH_SWEEP_SECONDS: z.coerce.number().int().nonnegative().default(600),
  /** Comma-separated origins that connect links may redirect back to. Empty = any https origin is refused. */
  ALLOWED_REDIRECT_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema> & {
  /** Platform-managed OAuth apps keyed by provider family (google, github, slack…). */
  platformOAuthApps: Record<string, { clientId: string; clientSecret: string }>;
  allowedRedirectOrigins: string[];
};

/**
 * Platform-managed OAuth apps come from env pairs `OAUTH_<PROVIDER>_CLIENT_ID` / `OAUTH_<PROVIDER>_CLIENT_SECRET`.
 * One Google app serves every Google toolkit, one Facebook app serves Facebook Pages and Instagram, etc.
 */
function readPlatformOAuthApps(env: NodeJS.ProcessEnv): Config['platformOAuthApps'] {
  const apps: Config['platformOAuthApps'] = {};
  for (const [key, value] of Object.entries(env)) {
    const m = /^OAUTH_([A-Z0-9_]+)_CLIENT_ID$/.exec(key);
    if (!m || !value) continue;
    const secret = env[`OAUTH_${m[1]}_CLIENT_SECRET`];
    if (!secret) continue;
    apps[m[1].toLowerCase().replace(/_/g, '-')] = { clientId: value, clientSecret: secret };
  }
  return apps;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${msg}`);
  }
  return {
    ...parsed.data,
    PUBLIC_URL: parsed.data.PUBLIC_URL.replace(/\/+$/, ''),
    platformOAuthApps: readPlatformOAuthApps(env),
    allowedRedirectOrigins: parsed.data.ALLOWED_REDIRECT_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
