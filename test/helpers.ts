import { randomBytes, createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { loadConfig, type Config } from '../src/config.js';
import { migrate, openDb } from '../src/db/index.js';
import { Registry, NATIVE_TOOLKITS } from '../src/catalog/registry.js';
import { pieceToToolkit, type ApPiece } from '../src/catalog/activepieces.js';
import { defineToolkit, bearer, httpJson } from '../src/catalog/native/define.js';
import { buildApp, createServices, type Services } from '../src/http/app.js';

export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';

/** A fake OAuth provider + API, so the full OAuth flow runs without the network. */
export async function startMockProvider() {
  const state = {
    issued: 0,
    lastTokenRequest: null as Record<string, string> | null,
    challenges: new Map<string, string>(),
    validTokens: new Set<string>(),
  };
  const app: FastifyInstance = Fastify();
  await app.register(formbody);
  app.post<{ Body: Record<string, string> }>('/token', async (req, reply) => {
    const b = req.body;
    state.lastTokenRequest = b;
    if (b.client_id !== 'mock-client' || b.client_secret !== 'mock-secret')
      return reply.status(401).send({ error: 'invalid_client' });
    if (b.grant_type === 'authorization_code') {
      const challenge = state.challenges.get(b.code);
      const expected = createHash('sha256')
        .update(b.code_verifier ?? '')
        .digest('base64url');
      if (!challenge || challenge !== expected)
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'PKCE mismatch' });
    } else if (b.grant_type === 'refresh_token') {
      if (b.refresh_token === 'revoked') return reply.status(400).send({ error: 'invalid_grant' });
    } else {
      return reply.status(400).send({ error: 'unsupported_grant_type' });
    }
    const token = `at_${++state.issued}`;
    state.validTokens.add(token);
    return {
      access_token: token,
      refresh_token: `rt_${state.issued}`,
      expires_in: 3600,
      token_type: 'bearer',
      scope: 'read',
    };
  });
  app.get('/me', async (req, reply) => {
    const t = req.headers.authorization?.replace('Bearer ', '') ?? '';
    if (!state.validTokens.has(t)) return reply.status(401).send({ error: 'bad token' });
    return { login: 'octo', token: t };
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    base,
    state,
    /** Simulate the user approving consent: register the PKCE challenge for a code. */
    approve(challenge: string) {
      const code = randomBytes(8).toString('hex');
      state.challenges.set(code, challenge);
      return code;
    },
    close: () => app.close(),
  };
}

export function mockOAuthToolkit(base: string) {
  return defineToolkit({
    slug: 'mockapp',
    name: 'Mock App',
    description: 'OAuth test toolkit',
    categories: [],
    authSchemes: [
      {
        type: 'OAUTH2',
        displayName: 'OAuth',
        fields: [],
        oauth2: {
          authUrl: `${base}/authorize`,
          tokenUrl: `${base}/token`,
          scopes: ['read'],
          pkce: true,
          pkceMethod: 'S256',
          authorizeParams: {},
          clientAuth: 'body',
          provider: 'mockapp',
        },
      },
    ],
    identify: async (auth) =>
      (await httpJson(`${base}/me`, { headers: { authorization: bearer(auth) } })).login,
    tools: [
      {
        name: 'whoami',
        displayName: 'Who am I',
        description: 'Returns the authenticated user',
        inputSchema: { type: 'object', properties: {} },
        run: (_a, auth) => httpJson(`${base}/me`, { headers: { authorization: bearer(auth) } }),
      },
    ],
  });
}

/** A fake Activepieces piece, run through the real adapter. */
export const fakePiece: ApPiece = {
  displayName: 'Fake Piece',
  description: 'Adapter test piece',
  auth: {
    type: 'SECRET_TEXT',
    displayName: 'API key',
    required: true,
    validate: async ({ auth }: { auth: string }) =>
      auth === 'good-key' ? { valid: true } : { valid: false, error: 'bad key' },
  },
  actions: () => ({
    echo: {
      name: 'echo',
      displayName: 'Echo',
      description: 'Echo inputs and auth back',
      props: {
        text: { type: 'SHORT_TEXT', displayName: 'Text', required: true },
        times: { type: 'NUMBER', displayName: 'Times', required: false, defaultValue: 2 },
        repo: {
          type: 'DROPDOWN',
          displayName: 'Repository',
          required: false,
          options: async ({ auth }: any) => ({
            options: auth ? [{ label: 'a/b', value: { owner: 'a', repo: 'b' } }] : [],
          }),
        },
        note: { type: 'MARKDOWN', displayName: 'Note' },
      },
      run: async (ctx: any) => {
        const count = ((await ctx.store.get('count')) ?? 0) + 1;
        await ctx.store.put('count', count);
        return { secret: ctx.auth.secret_text, props: ctx.propsValue, count };
      },
    },
  }),
};

export async function setup(opts: { withProvider?: boolean } = {}) {
  const provider = opts.withProvider ? await startMockProvider() : undefined;
  const config: Config = loadConfig({
    DATABASE_URL: 'pglite:memory',
    MASTER_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    ADMIN_TOKEN,
    PUBLIC_URL: 'http://hub.test',
    REFRESH_SWEEP_SECONDS: '0',
    OAUTH_MOCKAPP_CLIENT_ID: 'mock-client',
    OAUTH_MOCKAPP_CLIENT_SECRET: 'mock-secret',
    ALLOWED_REDIRECT_ORIGINS: 'https://app.example.com',
  } as any);
  const db = await openDb(config.DATABASE_URL);
  await migrate(db);
  const toolkits = [...NATIVE_TOOLKITS, pieceToToolkit('fake', fakePiece, '1.0.0')];
  if (provider) toolkits.push(mockOAuthToolkit(provider.base));
  const services: Services = createServices(config, db, new Registry(toolkits));
  const app = await buildApp(services, { logger: false });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/tenants',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload: { name: 'Acme' },
  });
  const { tenant, api_key } = res.json();
  const auth = { authorization: `Bearer ${api_key}` };
  return {
    app,
    services,
    provider,
    tenant,
    apiKey: api_key as string,
    auth,
    async close() {
      await app.close();
      await db.close();
      await provider?.close();
    },
  };
}
