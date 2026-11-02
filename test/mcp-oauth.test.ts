import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setup } from './helpers.js';

/** Mock Keycloak: discovery + token endpoint. "Logging in" is approve(), which mints a code for an email. */
async function startMockOidc() {
  const codes = new Map<string, { email: string; nonce: string; challenge: string; verified: boolean }>();
  const app: FastifyInstance = Fastify();
  await app.register(formbody);
  let base = '';
  app.get('/realms/bionic/.well-known/openid-configuration', async () => ({
    issuer: `${base}/realms/bionic`,
    authorization_endpoint: `${base}/realms/bionic/protocol/openid-connect/auth`,
    token_endpoint: `${base}/realms/bionic/protocol/openid-connect/token`,
  }));
  app.post<{ Body: Record<string, string> }>(
    '/realms/bionic/protocol/openid-connect/token',
    async (req, reply) => {
      const b = req.body;
      if (b.client_id !== 'hub' || b.client_secret !== 'hub-secret')
        return reply.status(401).send({ error: 'invalid_client' });
      const c = codes.get(b.code);
      const expected = createHash('sha256')
        .update(b.code_verifier ?? '')
        .digest('base64url');
      if (!c || c.challenge !== expected) return reply.status(400).send({ error: 'invalid_grant' });
      codes.delete(b.code);
      const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const idToken = `${enc({ alg: 'RS256' })}.${enc({
        iss: `${base}/realms/bionic`,
        aud: 'hub',
        sub: `sub-${c.email}`,
        email: c.email,
        email_verified: c.verified,
        name: 'Test Person',
        nonce: c.nonce,
        exp: Math.floor(Date.now() / 1000) + 300,
      })}.sig`;
      return { access_token: 'kc-at', id_token: idToken, token_type: 'Bearer' };
    },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  return {
    issuer: `${base}/realms/bionic`,
    approve(authorizeUrl: string, email: string, verified = true) {
      const u = new URL(authorizeUrl);
      const code = randomBytes(8).toString('hex');
      codes.set(code, {
        email,
        nonce: u.searchParams.get('nonce')!,
        challenge: u.searchParams.get('code_challenge')!,
        verified,
      });
      return { code, state: u.searchParams.get('state')! };
    },
    close: () => app.close(),
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
let oidc: Awaited<ReturnType<typeof startMockOidc>> | undefined;
afterEach(async () => {
  await ctx?.close();
  await oidc?.close();
  ctx = undefined;
  oidc = undefined;
});

const REDIRECT = 'https://org.example.com/oauth/callback';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function boot() {
  oidc = await startMockOidc();
  ctx = await setup({
    env: { OIDC_ISSUER: oidc.issuer, OIDC_CLIENT_ID: 'hub', OIDC_CLIENT_SECRET: 'hub-secret' },
  });
  const server = (
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/mcp-servers',
      headers: ctx.auth,
      payload: { name: 'Agents', toolkits: ['fake'] },
    })
  ).json();
  await ctx.app.inject({
    method: 'PUT',
    url: '/v1/settings/sso',
    headers: ctx.auth,
    payload: { allowed_domains: ['acme.test'] },
  });
  const client = (
    await ctx.app.inject({
      method: 'POST',
      url: '/oauth2/register',
      payload: { client_name: 'Paperclip', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
    })
  ).json();
  return { server, client, resource: `http://hub.test/mcp/s/${server.id}` };
}

/** Drive authorize → OIDC login → consent; returns the consent page and the final redirect. */
async function authorize(
  c: Ctx,
  clientId: string,
  resource: string,
  email: string,
  decision = 'allow',
  verified = true,
  browser: 'same' | 'other' = 'same',
) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    resource,
    scope: 'mcp',
  });
  const start = await c.app.inject({ method: 'GET', url: `/oauth2/authorize?${q}` });
  expect(start.statusCode).toBe(302);
  // Behave like a browser: the cookie set at /oauth2/authorize comes back on the callback and consent.
  const setCookie = String(start.headers['set-cookie'] ?? '');
  const cookie = browser === 'same' ? setCookie.split(';')[0] : '';
  const login = oidc!.approve(start.headers.location as string, email, verified);
  const cb = await c.app.inject({
    method: 'GET',
    url: `/oauth2/callback?code=${login.code}&state=${encodeURIComponent(login.state)}`,
    headers: cookie ? { cookie } : {},
  });
  if (cb.statusCode !== 200) return { consent: cb };
  const field = (n: string) => new RegExp(`name="${n}" value="([^"]+)"`).exec(cb.body)![1];
  const done = await c.app.inject({
    method: 'POST',
    url: '/oauth2/consent',
    payload: `request_id=${field('request_id')}&consent_token=${encodeURIComponent(field('consent_token'))}&decision=${decision}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  });
  return { consent: cb, done, back: new URL(done.headers.location as string), setCookie };
}

const token = (c: Ctx, body: Record<string, string>) =>
  c.app.inject({
    method: 'POST',
    url: '/oauth2/token',
    payload: new URLSearchParams(body).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

describe('MCP OAuth (hub as authorization server, Keycloak sign-in)', () => {
  it('advertises discovery from a 401 and serves both metadata documents', async () => {
    const { server } = await boot();
    const r = await ctx!.app.inject({ method: 'POST', url: `/mcp/s/${server.id}`, payload: {} });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toContain(
      `resource_metadata="http://hub.test/.well-known/oauth-protected-resource/mcp/s/${server.id}"`,
    );
    const prm = (
      await ctx!.app.inject({
        method: 'GET',
        url: `/.well-known/oauth-protected-resource/mcp/s/${server.id}`,
      })
    ).json();
    expect(prm).toMatchObject({
      resource: `http://hub.test/mcp/s/${server.id}`,
      authorization_servers: ['http://hub.test'],
    });
    const as = (
      await ctx!.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
    ).json();
    expect(as).toMatchObject({
      issuer: 'http://hub.test',
      code_challenge_methods_supported: ['S256'],
      registration_endpoint: 'http://hub.test/oauth2/register',
    });
  });

  it('registers clients and echoes their metadata (RFC 7591)', async () => {
    const { server, client } = await boot();
    expect(server.url).toBe(`http://hub.test/mcp/s/${server.id}`);
    expect(client).toMatchObject({
      client_name: 'Paperclip',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(client.client_secret).toBeUndefined();
    const bad = await ctx!.app.inject({
      method: 'POST',
      url: '/oauth2/register',
      payload: { redirect_uris: ['http://evil.example.com/cb'] },
    });
    expect(bad.json().error).toBe('invalid_redirect_uri');
  });

  it('runs the full flow and the access token drives a real MCP session as the signed-in user', async () => {
    const { server, client, resource } = await boot();
    const { consent, back } = await authorize(ctx!, client.client_id, resource, 'salil@acme.test');
    expect(consent.body).toContain('salil@acme.test');
    expect(consent.body).toContain('Paperclip');
    expect(back!.origin + back!.pathname).toBe(REDIRECT);
    expect(back!.searchParams.get('state')).toBe('client-state');
    expect(back!.searchParams.get('iss')).toBe('http://hub.test');
    const code = back!.searchParams.get('code')!;

    const t = await token(ctx!, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      resource,
    });
    expect(t.statusCode).toBe(200);
    const tokens = t.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    expect(t.headers['cache-control']).toBe('no-store');

    // Real MCP client with the OAuth access token.
    await ctx!.app.inject({
      method: 'POST',
      url: '/v1/connected-accounts',
      headers: ctx!.auth,
      payload: { user_id: 'salil@acme.test', toolkit: 'fake', credentials: { secret_text: 'good-key' } },
    });
    const address = await ctx!.app.listen({ port: 0, host: '127.0.0.1' });
    const mcp = new Client({ name: 'test', version: '1.0.0' });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp/s/${server.id}`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    const out: any = await mcp.callTool({ name: 'fake__echo', arguments: { text: 'via oauth' } });
    expect(JSON.parse(out.content[0].text)).toMatchObject({
      secret: 'good-key',
      props: { text: 'via oauth' },
    });
    await mcp.close();

    // The token is bound to this server only.
    const other = (
      await ctx!.app.inject({
        method: 'POST',
        url: '/v1/mcp-servers',
        headers: ctx!.auth,
        payload: { name: 'Other', toolkits: ['fake'] },
      })
    ).json();
    const wrong = await ctx!.app.inject({
      method: 'POST',
      url: `/mcp/s/${other.id}`,
      headers: { authorization: `Bearer ${tokens.access_token}` },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['www-authenticate']).toContain('invalid_token');

    // Grants are visible and revocable by the tenant.
    const grants = (
      await ctx!.app.inject({ method: 'GET', url: '/v1/mcp-oauth-grants', headers: ctx!.auth })
    ).json().items;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      user_id: 'salil@acme.test',
      server_id: server.id,
      client_name: 'Paperclip',
    });
  });

  it('rotates refresh tokens and revokes the whole grant when a used one is replayed', async () => {
    const { server, client, resource } = await boot();
    const { back } = await authorize(ctx!, client.client_id, resource, 'a@acme.test');
    const first = (
      await token(ctx!, {
        grant_type: 'authorization_code',
        code: back!.searchParams.get('code')!,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
      })
    ).json();
    const second = (
      await token(ctx!, {
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: client.client_id,
      })
    ).json();
    expect(second.access_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const probe = (t: string) =>
      ctx!.app.inject({
        method: 'POST',
        url: `/mcp/s/${server.id}`,
        headers: { authorization: `Bearer ${t}`, accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
    expect((await probe(first.access_token)).statusCode).toBe(401); // superseded
    expect((await probe(second.access_token)).statusCode).toBe(200);

    const replay = await token(ctx!, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: client.client_id,
    });
    expect(replay.json().error).toBe('invalid_grant');
    expect((await probe(second.access_token)).statusCode).toBe(401); // family revoked
  });

  it('enforces the tenant sign-in policy, consent denial and request validation', async () => {
    const { client, resource } = await boot();
    const outsider = await authorize(ctx!, client.client_id, resource, 'mallory@other.test');
    expect(outsider.consent.statusCode).toBe(403);
    expect(outsider.consent.body).toContain('not allowed');

    const unverified = await authorize(ctx!, client.client_id, resource, 'c@acme.test', 'allow', false);
    expect(unverified.consent.statusCode).toBe(403);
    expect(unverified.consent.body).toContain('verified email');

    const denied = await authorize(ctx!, client.client_id, resource, 'b@acme.test', 'deny');
    expect(denied.back!.searchParams.get('error')).toBe('access_denied');
    expect(denied.back!.searchParams.get('code')).toBeNull();

    const page = await ctx!.app.inject({
      method: 'GET',
      url: `/oauth2/authorize?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}`,
    });
    expect(page.statusCode).toBe(400);
    const mismatch = await ctx!.app.inject({
      method: 'GET',
      url: `/oauth2/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`,
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.headers.location).toBeUndefined();

    const noPkce = await ctx!.app.inject({
      method: 'GET',
      url: `/oauth2/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&resource=${encodeURIComponent(resource)}&state=s`,
    });
    expect(new URL(noPkce.headers.location as string).searchParams.get('error')).toBe('invalid_request');
    const badResource = await ctx!.app.inject({
      method: 'GET',
      url: `/oauth2/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent('https://elsewhere.example.com/mcp')}`,
    });
    expect(new URL(badResource.headers.location as string).searchParams.get('error')).toBe('invalid_target');
  });

  it('keeps per-user chm_ tokens working on the per-server endpoint, but only for their own server', async () => {
    const { server } = await boot();
    const tok = (
      await ctx!.app.inject({
        method: 'POST',
        url: `/v1/mcp-servers/${server.id}/tokens`,
        headers: ctx!.auth,
        payload: { user_id: 'u1' },
      })
    ).json();
    const ok = await ctx!.app.inject({
      method: 'POST',
      url: `/mcp/s/${server.id}`,
      headers: { authorization: `Bearer ${tok.token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(ok.statusCode).toBe(200);
    const other = (
      await ctx!.app.inject({
        method: 'POST',
        url: '/v1/mcp-servers',
        headers: ctx!.auth,
        payload: { name: 'Other', toolkits: ['fake'] },
      })
    ).json();
    const no = await ctx!.app.inject({
      method: 'POST',
      url: `/mcp/s/${other.id}`,
      headers: { authorization: `Bearer ${tok.token}` },
      payload: {},
    });
    expect(no.statusCode).toBe(401);
  });

  it('refuses to continue a sign-in in a browser other than the one that started it (request forgery)', async () => {
    const { client, resource } = await boot();
    // Attacker starts the flow with their own client and sends the Keycloak link to a victim.
    const forged = await authorize(
      ctx!,
      client.client_id,
      resource,
      'victim@acme.test',
      'allow',
      true,
      'other',
    );
    expect(forged.consent.statusCode).toBe(403);
    expect(forged.consent.body).toContain('different browser');
    // The legitimate path sets a host-only, HttpOnly, SameSite cookie.
    const ok = await authorize(ctx!, client.client_id, resource, 'a@acme.test');
    expect(ok.setCookie).toMatch(/^chub_oauth=[A-Za-z0-9_-]+; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(ok.back!.searchParams.get('code')).toBeTruthy();
  });

  it('cuts off access when the tenant removes a person or domain from the sign-in policy', async () => {
    const { server, client, resource } = await boot();
    const { back } = await authorize(ctx!, client.client_id, resource, 'leaver@acme.test');
    const tokens = (
      await token(ctx!, {
        grant_type: 'authorization_code',
        code: back!.searchParams.get('code')!,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
      })
    ).json();
    const probe = (t: string) =>
      ctx!.app.inject({
        method: 'POST',
        url: `/mcp/s/${server.id}`,
        headers: { authorization: `Bearer ${t}`, accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
    expect((await probe(tokens.access_token)).statusCode).toBe(200);
    await ctx!.app.inject({
      method: 'PUT',
      url: '/v1/settings/sso',
      headers: ctx!.auth,
      payload: { allowed_domains: ['other.test'] },
    });
    expect((await probe(tokens.access_token)).statusCode).toBe(401);
    const refreshed = await token(ctx!, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    expect(refreshed.json().error).toBe('invalid_grant');
  });

  it('does not burn a code on a failed redemption, and a replayed code revokes the tokens it produced', async () => {
    const { server, client, resource } = await boot();
    const { back } = await authorize(ctx!, client.client_id, resource, 'a@acme.test');
    const code = back!.searchParams.get('code')!;
    const wrong = await token(ctx!, {
      grant_type: 'authorization_code',
      code,
      code_verifier: 'not-the-verifier',
      redirect_uri: REDIRECT,
      client_id: client.client_id,
    });
    expect(wrong.json().error_description).toContain('PKCE');
    const good = (
      await token(ctx!, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
      })
    ).json();
    expect(good.access_token).toBeTruthy();
    const replay = await token(ctx!, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
    });
    expect(replay.json().error).toBe('invalid_grant');
    const probe = await ctx!.app.inject({
      method: 'POST',
      url: `/mcp/s/${server.id}`,
      headers: { authorization: `Bearer ${good.access_token}` },
      payload: {},
    });
    expect(probe.statusCode).toBe(401);
  });

  it('answers malformed registration and client credentials with OAuth errors, not 500s', async () => {
    await boot();
    const reg = await ctx!.app.inject({
      method: 'POST',
      url: '/oauth2/register',
      payload: { redirect_uris: [REDIRECT], grant_types: 'authorization_code' },
    });
    expect(reg.statusCode).toBe(400);
    expect(reg.json().error).toBe('invalid_client_metadata');
    const basic = await ctx!.app.inject({
      method: 'POST',
      url: '/oauth2/token',
      headers: {
        authorization: `Basic ${Buffer.from('%E0%A4%A:x').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'grant_type=refresh_token&refresh_token=x',
    });
    expect(basic.statusCode).toBe(401);
    expect(basic.json().error).toBe('invalid_client');
  });
});
