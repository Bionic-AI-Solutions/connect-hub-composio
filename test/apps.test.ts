import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function startSignIn(c: Ctx, userId: string, redirect?: string) {
  const link = await c.app.inject({
    method: 'POST',
    url: '/v1/connected-accounts/link',
    headers: c.auth,
    payload: { user_id: userId, toolkit: 'mockapp', redirect_url: redirect },
  });
  expect(link.statusCode).toBe(201);
  const u = new URL(link.json().connect_url);
  const start = await c.app.inject({ method: 'GET', url: u.pathname + u.search });
  expect(start.statusCode).toBe(302);
  return new URL(start.headers.location as string);
}

const apps = async (c: Ctx, user?: string) =>
  (
    await c.app.inject({ method: 'GET', url: `/v1/apps${user ? `?user_id=${user}` : ''}`, headers: c.auth })
  ).json().items as any[];

describe('App picker', () => {
  it('says how each app connects: provider sign-in, a form, or setup needed first', async () => {
    ctx = await setup({ withProvider: true });
    const items = await apps(ctx);
    const by = (slug: string) => items.find((a) => a.slug === slug);
    // Platform OAuth app from OAUTH_MOCKAPP_* → one-click sign-in.
    expect(by('mockapp')).toMatchObject({
      connect: 'oauth',
      oauth_provider: 'mockapp',
      oauth_source: 'platform',
    });
    // Atlassian is OAuth-only and has no OAuth app yet.
    expect(by('atlassian')).toMatchObject({
      connect: 'setup_required',
      oauth_provider: 'atlassian',
      oauth_source: 'none',
    });
    // Cloudflare takes an API token on the hub's form.
    expect(by('cloudflare')).toMatchObject({ connect: 'form', oauth_provider: null });
    expect(by('mockapp').accounts).toEqual({ active: 0, needs_attention: 0 });
  });

  it('counts the person’s connected accounts after they sign in, and returns to the dashboard', async () => {
    ctx = await setup({ withProvider: true });
    const authorize = await startSignIn(ctx, 'me@example.com', 'http://hub.test/dashboard#apps');
    const code = ctx.provider!.approve(authorize.searchParams.get('code_challenge')!);
    const cb = await ctx.app.inject({
      method: 'GET',
      url: `/oauth/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
    });
    expect(cb.statusCode).toBe(302);
    const back = new URL(cb.headers.location as string);
    expect(back.origin + back.pathname).toBe('http://hub.test/dashboard');
    expect(back.searchParams.get('status')).toBe('success');
    expect((await apps(ctx, 'me@example.com')).find((a) => a.slug === 'mockapp').accounts.active).toBe(1);
    expect(
      (await apps(ctx, 'someone-else@example.com')).find((a) => a.slug === 'mockapp').accounts.active,
    ).toBe(0);
  });

  it('still refuses redirects to other sites', async () => {
    ctx = await setup({ withProvider: true });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/connected-accounts/link',
      headers: ctx.auth,
      payload: { user_id: 'u1', toolkit: 'mockapp', redirect_url: 'https://evil.example/steal' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('One-time OAuth setup per provider', () => {
  it('lists each provider with the callback URL and console link, never a secret', async () => {
    ctx = await setup({ withProvider: true });
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/oauth-providers', headers: ctx.auth });
    expect(res.statusCode).toBe(200);
    const atl = res.json().items.find((p: any) => p.provider === 'atlassian');
    expect(atl).toMatchObject({
      name: 'Atlassian',
      callback_url: 'http://hub.test/oauth/callback',
      source: 'none',
      client_id: null,
    });
    expect(atl.console_url).toMatch(/^https:\/\/developer\.atlassian\.com\//);
    expect(atl.toolkits.map((t: any) => t.slug)).toContain('atlassian');
  });

  it('stores one app for the whole provider, uses it for sign-in, and falls back when removed', async () => {
    ctx = await setup({ withProvider: true });
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/oauth-providers/mockapp',
      headers: ctx.auth,
      payload: { client_id: 'tenant-client', client_secret: 'tenant-secret-value' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ source: 'tenant', client_id: 'tenant-client' });
    expect(put.body).not.toContain('tenant-secret-value');
    // Stored encrypted, scoped to this tenant.
    const { rows } = await ctx.services.db.query(
      "SELECT client_secret_enc FROM auth_configs WHERE tenant_id = $1 AND toolkit = 'mockapp'",
      [ctx.tenant.id],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('tenant-secret-value');
    expect((await startSignIn(ctx, 'u1')).searchParams.get('client_id')).toBe('tenant-client');

    // Saving again replaces it rather than piling up rows.
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/oauth-providers/mockapp',
      headers: ctx.auth,
      payload: { client_id: 'tenant-client-2', client_secret: 'second-secret' },
    });
    expect((await startSignIn(ctx, 'u1')).searchParams.get('client_id')).toBe('tenant-client-2');
    const after = await ctx.services.db.query(
      "SELECT id FROM auth_configs WHERE tenant_id = $1 AND toolkit = 'mockapp'",
      [ctx.tenant.id],
    );
    expect(after.rows).toHaveLength(1);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/oauth-providers/mockapp',
      headers: ctx.auth,
    });
    expect(del.json()).toMatchObject({ source: 'platform' });
    expect((await startSignIn(ctx, 'u1')).searchParams.get('client_id')).toBe('mock-client');
  });

  it('makes an OAuth-only app connectable once its provider is set up', async () => {
    ctx = await setup({ withProvider: true });
    const before = await ctx.app.inject({
      method: 'POST',
      url: '/v1/connected-accounts/link',
      headers: ctx.auth,
      payload: { user_id: 'u1', toolkit: 'atlassian' },
    });
    expect(before.statusCode).toBe(409);
    expect(before.json().error.message).toMatch(/Set up/);
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/oauth-providers/atlassian',
      headers: ctx.auth,
      payload: { client_id: 'atl-client', client_secret: 'atl-secret' },
    });
    expect((await apps(ctx)).find((a) => a.slug === 'atlassian')).toMatchObject({
      connect: 'oauth',
      oauth_source: 'tenant',
    });
    const after = await ctx.app.inject({
      method: 'POST',
      url: '/v1/connected-accounts/link',
      headers: ctx.auth,
      payload: { user_id: 'u1', toolkit: 'atlassian' },
    });
    expect(after.statusCode).toBe(201);
  });

  it('keeps each tenant’s OAuth apps to itself and validates input', async () => {
    ctx = await setup({ withProvider: true });
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/oauth-providers/atlassian',
      headers: ctx.auth,
      payload: { client_id: 'acme-client', client_secret: 'acme-secret' },
    });
    const other = (
      await ctx.app.inject({
        method: 'POST',
        url: '/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { name: 'Other' },
      })
    ).json();
    const otherAuth = { authorization: `Bearer ${other.api_key}` };
    const seen = (
      await ctx.app.inject({ method: 'GET', url: '/v1/oauth-providers', headers: otherAuth })
    ).json();
    expect(seen.items.find((p: any) => p.provider === 'atlassian')).toMatchObject({
      source: 'none',
      client_id: null,
    });
    // Removing in the other tenant does not touch Acme's app.
    await ctx.app.inject({ method: 'DELETE', url: '/v1/oauth-providers/atlassian', headers: otherAuth });
    const mine = (
      await ctx.app.inject({ method: 'GET', url: '/v1/oauth-providers', headers: ctx.auth })
    ).json();
    expect(mine.items.find((p: any) => p.provider === 'atlassian')).toMatchObject({
      source: 'tenant',
      client_id: 'acme-client',
    });

    const bad = (payload: object, provider = 'atlassian') =>
      ctx!.app.inject({ method: 'PUT', url: `/v1/oauth-providers/${provider}`, headers: ctx!.auth, payload });
    expect((await bad({ client_id: 'x' })).statusCode).toBe(400);
    expect((await bad({ client_id: 'x', client_secret: 'y' }, 'no-such-provider')).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/oauth-providers' })).statusCode).toBe(401);
  });
});
